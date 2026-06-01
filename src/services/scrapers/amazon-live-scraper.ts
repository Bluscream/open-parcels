import { eq } from "drizzle-orm";
import { type BrowserContext, chromium, type Page } from "playwright";
import { db } from "../../db";
import { credentials, parcelEvents, parcels } from "../../db/schema";
import { decryptCredential, encryptCredential } from "../../utils/crypto";
import { wsBroker } from "../websocket";
import { BaseScraper, type ScraperResult } from "./index";

export interface AmazonLiveCredentials {
	email?: string;
	password?: string;
	cookies?: {
		name: string;
		value: string;
		url?: string;
		domain?: string;
		path?: string;
		expires?: number;
		httpOnly?: boolean;
		secure?: boolean;
		sameSite?: "Strict" | "Lax" | "None";
	}[];
}

export class AmazonLiveScraper extends BaseScraper<AmazonLiveCredentials> {
	public static activeScrapers = new Map<number, AmazonLiveScraper>();

	private browserContext: BrowserContext | null = null;
	private page: Page | null = null;
	private csrfToken: string | null = null;
	private isPolling = false;
	private pollInterval: NodeJS.Timeout | null = null;
	private memoizationCount = 0;
	private parcelId: number | null = null;

	/**
	 * Initializes browser, loads cookies, or logs in if necessary
	 */
	async authenticate(creds: AmazonLiveCredentials): Promise<boolean> {
		try {
			const browser = await chromium.launch({ headless: true });
			this.browserContext = await browser.newContext();

			// Load saved cookies if they exist
			if (creds.cookies && creds.cookies.length > 0) {
				await this.browserContext.addCookies(creds.cookies);
			}

			this.page = await this.browserContext.newPage();

			// Navigate to the ship-track page to check auth state
			await this.page.goto(this.config.url, {
				waitUntil: "load",
				timeout: 60000,
			});

			// Check if we are redirected to sign-in page
			const isSignIn =
				this.page.url().includes("/ap/signin") ||
				(await this.page.$('input[name="email"]')) !== null;

			if (isSignIn) {
				console.log(
					"[AmazonLiveScraper] Stored session invalid, attempting full login...",
				);
				if (!creds.email || !creds.password) {
					console.error(
						"[AmazonLiveScraper] Stored session expired and no email/password credentials provided.",
					);
					return false;
				}

				// Fill in email
				await this.page.fill('input[name="email"]', creds.email);
				await this.page.click("input#continue");
				await this.page.waitForTimeout(1000);

				// Fill in password
				await this.page.fill('input[name="password"]', creds.password);
				await this.page.click("input#signInSubmit");
				await this.page.waitForNavigation({
					waitUntil: "load",
					timeout: 60000,
				});

				// Handle potential OTP/2FA request or manual intervention
				if (
					this.page.url().includes("approval") ||
					this.page.url().includes("cvf")
				) {
					console.warn(
						"[AmazonLiveScraper] 2FA/OTP or Approval page encountered. Please complete it manually in browser or check credentials.",
					);
					return false;
				}

				// Return to ship-track page after successful login
				await this.page.goto(this.config.url, {
					waitUntil: "load",
					timeout: 60000,
				});
			}

			// Check if authenticated successfully now
			const currentUrl = this.page.url();
			if (currentUrl.includes("/ap/signin")) {
				console.error(
					"[AmazonLiveScraper] Authentication failed. Redirected back to login.",
				);
				return false;
			}

			// Extract cookies and csrfToken
			const newCookies = await this.browserContext.cookies();
			this.csrfToken = await this.page.evaluate(
				() => (window as { csrfToken?: string }).csrfToken || null,
			);
			console.log(
				`[AmazonLiveScraper] Successfully authenticated. Extracted CSRF Token: ${this.csrfToken}`,
			);

			// Save updated cookies back to database credentials so we skip login next time
			const existingCred = await db
				.select()
				.from(credentials)
				.where(eq(credentials.service, "Amazon"))
				.limit(1);
			if (existingCred.length > 0) {
				const decryptedData = JSON.parse(
					decryptCredential(existingCred[0].encryptedData),
				);
				decryptedData.cookies = newCookies;
				const encrypted = encryptCredential(JSON.stringify(decryptedData));
				await db
					.update(credentials)
					.set({
						encryptedData: encrypted,
						updatedAt: new Date(),
					})
					.where(eq(credentials.id, existingCred[0].id));
				console.log("[AmazonLiveScraper] Cookies updated in DB.");
			}

			return true;
		} catch (err) {
			console.error("[AmazonLiveScraper] Auth failed:", err);
			return false;
		}
	}

	/**
	 * Main polling/syncing implementation
	 */
	async scrape(): Promise<ScraperResult> {
		// Standard scraping: performs a single-shot tracking check
		// In our live tracking flow, we use the startLivePolling method below.
		return { success: true };
	}

	/**
	 * Starts high-frequency polling when a parcel is out for delivery/active
	 */
	public async startLivePolling(parcelId: number, trackingNumber: string) {
		if (this.isPolling) return;
		this.isPolling = true;
		this.parcelId = parcelId;
		this.memoizationCount = 0;
		AmazonLiveScraper.activeScrapers.set(parcelId, this);

		console.log(
			`[AmazonLiveScraper] Starting live polling for parcel ${trackingNumber} (ID: ${parcelId})...`,
		);

		// 1. Initial Timeline Ingestion (get-state) to load full coordinates history path
		await this.syncTimelineState(parcelId, trackingNumber);

		// 2. Spawn periodic poller (every 30 seconds)
		this.pollInterval = setInterval(async () => {
			try {
				const active = await this.pollRealTimeUpdate(parcelId, trackingNumber);
				if (!active) {
					console.log(
						`[AmazonLiveScraper] Live tracking session finished or unavailable for ${trackingNumber}. Stopping poller.`,
					);
					this.stopLivePolling();
				}
			} catch (err) {
				console.error("[AmazonLiveScraper] Error in poller cycle:", err);
			}
		}, 30000);
	}

	/**
	 * Stops live tracking polling loop
	 */
	public stopLivePolling() {
		this.isPolling = false;
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		if (this.parcelId !== null) {
			AmazonLiveScraper.activeScrapers.delete(this.parcelId);
		}
		console.log("[AmazonLiveScraper] Live polling stopped.");
	}

	/**
	 * Polls real-time deans-proxy coordinates and then resolves text via /memoize
	 */
	private async pollRealTimeUpdate(
		parcelId: number,
		trackingNumber: string,
	): Promise<boolean> {
		if (!this.page || !this.csrfToken) return false;

		console.log(
			`[AmazonLiveScraper] Polling active driver location for ${trackingNumber}...`,
		);

		try {
			// POST to deans-proxy to get current coordinates
			const deansProxyUrl =
				"https://www.amazon.de/progress-tracker/package/actions/map-tracking-deans-proxy";
			const proxyResponseText = await this.page.evaluate(
				async (args) => {
					const resp = await fetch(args.url, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
							"X-Requested-With": "XMLHttpRequest",
						},
						body: `trackingId=${args.trackingNumber}&csrfToken=${args.csrfToken}`,
					});
					if (!resp.ok) return null;
					return resp.text();
				},
				{ url: deansProxyUrl, trackingNumber, csrfToken: this.csrfToken },
			);

			if (!proxyResponseText) {
				console.log(
					"[AmazonLiveScraper] Failed to fetch deans-proxy coordinates.",
				);
				return false;
			}

			const proxyData = JSON.parse(proxyResponseText);
			if (!proxyData.success || !proxyData.packageLocationDetails) {
				console.log(
					"[AmazonLiveScraper] Real-time tracking not currently active for this parcel.",
				);
				return false;
			}

			const details = proxyData.packageLocationDetails;
			const status = details.trackingObjectState; // e.g. YOU_ARE_NEXT, SKIPPED_STOP
			const stops = details.stopsRemaining;

			// Extract driver & destination coordinates
			const driverLat = details.transporterDetails?.geoLocation?.latitude;
			const driverLng = details.transporterDetails?.geoLocation?.longitude;
			const destLat = details.destinationAddress?.geoLocation?.latitude;
			const destLng = details.destinationAddress?.geoLocation?.longitude;

			if (!driverLat || !driverLng) {
				console.log(
					"[AmazonLiveScraper] No active driver coordinates found in response.",
				);
				return false;
			}

			// POST to /memoize to log state and resolve localized strings (Zustellung heute / Sie sind der Nächste!)
			const memoizeUrl =
				"https://www.amazon.de/progress-tracker/package/actions/map-tracking/memoize";
			const memoizePayload = `trackingId=${trackingNumber}&status=${status}&csrfToken=${this.csrfToken}&numberOfMemoizations=${this.memoizationCount}&isDriverPhotoPresent=false&stops=${stops}&timezone=Europe%2FBerlin&visitTrigger=UNKNOWN`;

			const memoizeResponseText = await this.page.evaluate(
				async (args) => {
					const resp = await fetch(args.url, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
							"X-Requested-With": "XMLHttpRequest",
						},
						body: args.payload,
					});
					if (!resp.ok) return null;
					return resp.text();
				},
				{ url: memoizeUrl, payload: memoizePayload },
			);

			this.memoizationCount++;

			let calloutMessage = "Arriving today";
			let secondaryStatus = "Driver is close";

			if (memoizeResponseText) {
				const memoizeData = JSON.parse(memoizeResponseText);
				if (memoizeData.success && memoizeData.value) {
					calloutMessage = memoizeData.value.calloutMessage || calloutMessage;
					secondaryStatus =
						memoizeData.value.secondaryStatus || secondaryStatus;
				}
			}

			console.log(
				`[AmazonLiveScraper] Live Update: Status=${status}, Stops=${stops}, Callout="${calloutMessage}", Secondary="${secondaryStatus}", Coordinates=[${driverLat}, ${driverLng}]`,
			);

			// 3. Update database state
			await db
				.update(parcels)
				.set({
					status: "arriving",
					lat: driverLat,
					lng: driverLng,
					updatedAt: new Date(),
				})
				.where(eq(parcels.id, parcelId));

			// 4. Ingest new event, avoiding duplicates
			const description = `Driver is ${stops} stops away [${calloutMessage}: ${secondaryStatus}]`;
			const existing = await db
				.select()
				.from(parcelEvents)
				.where(eq(parcelEvents.parcelId, parcelId));

			const isDuplicate = existing.some(
				(e) =>
					e.description === description &&
					e.lat === driverLat &&
					e.lng === driverLng,
			);

			if (!isDuplicate) {
				await db.insert(parcelEvents).values({
					parcelId,
					location: "In transit (Live)",
					description,
					timestamp: new Date(),
					lat: driverLat,
					lng: driverLng,
				});
			}

			// 5. Fetch updated parcel nickname from DB to format WebSocket broadcast payload
			const fullParcel = await db
				.select()
				.from(parcels)
				.where(eq(parcels.id, parcelId))
				.limit(1);
			const parcelNickname = fullParcel[0].name || "";

			// 6. Broadcast WebSockets update!
			const broadcastData = {
				id: parcelId,
				trackingNumber,
				name: parcelNickname,
				status: "arriving",
				stopsRemaining: stops,
				calloutMessage,
				secondaryStatus,
				lat: driverLat,
				lng: driverLng,
				destinationLat: destLat,
				destinationLng: destLng,
				updatedAt: new Date().toISOString(),
			};

			wsBroker.broadcast(`parcel:${trackingNumber}`, broadcastData);
			wsBroker.broadcast("all", broadcastData);

			// Return true to keep polling
			return status !== "DELIVERED";
		} catch (err) {
			console.error("[AmazonLiveScraper] Failed to poll active update:", err);
			return false;
		}
	}

	/**
	 * Syncs historical timeline coordinates using /get-state
	 */
	private async syncTimelineState(parcelId: number, trackingNumber: string) {
		if (!this.page || !this.csrfToken) return;

		try {
			console.log(
				`[AmazonLiveScraper] Ingesting initial timeline state history for ${trackingNumber}...`,
			);
			const getStateUrl =
				"https://www.amazon.de/progress-tracker/package/actions/package-location/get-state";
			const payload = `trackingId=${trackingNumber}&visitTrigger=UNKNOWN&timezone=Europe%2FBerlin&csrfToken=${this.csrfToken}&numberOfMemoizations=0&isDriverPhotoPresent=false`;

			const responseText = await this.page.evaluate(
				async (args) => {
					const resp = await fetch(args.url, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
							"X-Requested-With": "XMLHttpRequest",
						},
						body: args.payload,
					});
					if (!resp.ok) return null;
					return resp.text();
				},
				{ url: getStateUrl, payload },
			);

			if (responseText) {
				const res = JSON.parse(responseText);
				if (
					res.success &&
					res.value &&
					Array.isArray(res.value.packageLocationTimeline)
				) {
					const timeline = res.value.packageLocationTimeline;
					console.log(
						`[AmazonLiveScraper] Found ${timeline.length} timeline path points.`,
					);

					// Save timeline history points in parcelEvents as historical driver markers
					for (let i = 0; i < timeline.length; i++) {
						const point = timeline[i];
						const lat = point.mappedPosition?.latitude;
						const lng = point.mappedPosition?.longitude;
						const time = point.timestamp
							? new Date(point.timestamp)
							: new Date();

						if (lat && lng) {
							const description = `Historical route location point ${i + 1}`;
							const existing = await db
								.select()
								.from(parcelEvents)
								.where(eq(parcelEvents.parcelId, parcelId));
							const isDuplicate = existing.some(
								(e) =>
									e.lat === lat &&
									e.lng === lng &&
									e.description.startsWith("Historical route"),
							);

							if (!isDuplicate) {
								await db.insert(parcelEvents).values({
									parcelId,
									location: "Timeline Route",
									description,
									timestamp: time,
									lat,
									lng,
								});
							}
						}
					}
				}
			}
		} catch (err) {
			console.error(
				"[AmazonLiveScraper] Failed to sync timeline state history:",
				err,
			);
		}
	}

	async close(): Promise<void> {
		this.stopLivePolling();
		if (this.page) {
			await this.page.close().catch(() => {});
			this.page = null;
		}
		if (this.browserContext) {
			await this.browserContext.close().catch(() => {});
			this.browserContext = null;
		}
	}
}
