import { eq } from "drizzle-orm";
import { type BrowserContext, chromium, type Page } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { db } from "../../db";
import { credentials, parcelEvents, parcels } from "../../db/schema";
import { decryptCredential, encryptCredential } from "../../utils/crypto";
import { wsBroker } from "../websocket";
import { BaseScraper, type ScraperResult } from "./index";
import { requestQueue } from "../../utils/requestQueue";
import { syncParcelStateFromEvents, determineSingleEventVehicle } from "../tracking/sync";

function base32Decode(base32: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const clean = base32.toUpperCase().replace(/=+$/, "");
	const length = clean.length;
	let bits = 0;
	let value = 0;
	let index = 0;
	const buffer = Buffer.alloc(Math.floor((length * 5) / 8));

	for (let i = 0; i < length; i++) {
		const val = alphabet.indexOf(clean[i]);
		if (val === -1) throw new Error("Invalid Base32 character");
		value = (value << 5) | val;
		bits += 5;
		if (bits >= 8) {
			buffer[index++] = (value >>> (bits - 8)) & 255;
			bits -= 8;
		}
	}
	return buffer;
}

export function generateTOTP(secret: string): string {
	const key = base32Decode(secret.replace(/\s+/g, ""));
	const epoch = Math.floor(Date.now() / 1000);
	const counter = Math.floor(epoch / 30);

	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeUInt32BE(counter, 4);

	const hmac = crypto.createHmac("sha1", key);
	hmac.update(counterBuffer);
	const hash = hmac.digest();

	const offset = hash[hash.length - 1] & 0xf;
	const code =
		((hash[offset] & 0x7f) << 24) |
		((hash[offset + 1] & 0xff) << 16) |
		((hash[offset + 2] & 0xff) << 8) |
		(hash[offset + 3] & 0xff);

	const otp = code % 1000000;
	return otp.toString().padStart(6, "0");
}

export function parseGermanDate(dateStr: string): Date {
	const now = new Date();
	const year = now.getFullYear();
	
	// Normalize string (strip weekday prefix)
	const cleanStr = dateStr.replace(/^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*/i, "").trim();
	
	const monthsGerman = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
	const monthsEnglish = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
	
	// Try parsing standard formats first
	let parsed = new Date(dateStr);
	if (!Number.isNaN(parsed.getTime())) {
		// If year is way off (e.g. 2001 or less), let's correct it to current year
		if (parsed.getFullYear() < 2020) {
			parsed.setFullYear(year);
		}
		return parsed;
	}
	
	// Manual regex parse: "2. Juni 2:14" or "1. Juni 20:48" or "1. Juni" or "2 June" etc.
	// Match: Day. Month (optional Hour:Minute)
	const match = cleanStr.match(/^(\d+)(?:\.|\b)\s+([^\s\d,]+)(?:\s+(\d+):(\d+))?/i);
	if (match) {
		const day = parseInt(match[1], 10);
		const monthName = match[2].toLowerCase();
		const hour = match[3] ? parseInt(match[3], 10) : 0;
		const min = match[4] ? parseInt(match[4], 10) : 0;
		
		let monthIdx = monthsGerman.findIndex(m => monthName.startsWith(m));
		if (monthIdx === -1) {
			monthIdx = monthsEnglish.findIndex(m => monthName.startsWith(m));
		}
		if (monthIdx === -1) {
			// Fallback to English/German abbreviations
			const shortMonths = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
			monthIdx = shortMonths.findIndex(m => monthName.startsWith(m));
		}
		
		if (monthIdx !== -1) {
			const d = new Date(year, monthIdx, day, hour, min, 0, 0);
			// If the parsed date is in the future compared to now, it might be from last year
			if (d.getTime() > now.getTime() + 1000 * 60 * 60 * 24 * 7) {
				d.setFullYear(year - 1);
			}
			return d;
		}
	}
	
	return now;
}


export interface AmazonLiveCredentials {
	email?: string;
	username?: string;
	password?: string;
	otpSecret?: string;
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
	public static activeScrapers = new Map<string, AmazonLiveScraper>();

	private browserContext: BrowserContext | null = null;
	private page: Page | null = null;
	private csrfToken: string | null = null;
	private isPolling = false;
	private pollInterval: NodeJS.Timeout | null = null;
	private memoizationCount = 0;
	private parcelId: string | null = null;

	/**
	 * Initializes browser, loads cookies, or logs in if necessary
	 */
	async authenticate(creds: AmazonLiveCredentials): Promise<boolean> {
		try {
			// Resolve Chromium path: env var override → system default → let Playwright decide
			const chromiumPath =
				process.env.PLAYWRIGHT_CHROMIUM_PATH ||
				process.env.PUPPETEER_EXECUTABLE_PATH ||
				"/usr/bin/chromium";
			console.log(`[AmazonLiveScraper] Using Chromium at: ${chromiumPath}`);

			// Persistent user data dir: keeps cookies/session alive across server restarts
			// so Amazon login only needs to happen once (or when the session expires).
			const userDataDir = path.resolve(
				process.env.AMAZON_SESSION_DIR ||
				path.join(process.cwd(), ".scratch", "amazon-session"),
			);

			this.browserContext = await chromium.launchPersistentContext(userDataDir, {
				headless: true,
				executablePath: chromiumPath,
				args: [
					"--disable-blink-features=AutomationControlled",
					"--no-sandbox",
					"--disable-setuid-sandbox",
				],
				viewport: { width: 1280, height: 800 },
				locale: "de-DE",
				timezoneId: "Europe/Berlin",
			});

			// Load saved cookies if they exist
			if (creds.cookies && creds.cookies.length > 0) {
				await this.browserContext!.addCookies(creds.cookies);
			}

			// Mask webdriver automation flag and mock standard Chrome browser properties
			this.page = await this.browserContext!.newPage();
			await this.page.addInitScript(() => {
				Object.defineProperty(navigator, "webdriver", {
					get: () => undefined,
				});
				Object.defineProperty(navigator, "languages", {
					get: () => ["de-DE", "de", "en-US", "en"],
				});
				(window as any).chrome = {
					app: {
						isInstalled: false,
						InstallState: { DISABLED: "DISABLED", INSTALLED: "INSTALLED", NOT_INSTALLED: "NOT_INSTALLED" },
						runningState: () => "CANNOT_RUN",
						getInstallState: () => "NOT_INSTALLED",
						getDetails: () => null
					},
					runtime: {
						OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
						OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
						PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
						PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
						PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
						RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" }
					}
				};
				const originalQuery = window.navigator.permissions.query;
				window.navigator.permissions.query = (parameters) => (
					parameters.name === "notifications" ?
						Promise.resolve({ state: Notification.permission } as PermissionStatus) :
						originalQuery(parameters)
				);

				// Disable WebAuthn / Passkeys completely so that Amazon falls back to standard passwords
				delete (window as any).PublicKeyCredential;
				if (navigator.credentials) {
					navigator.credentials.get = () => Promise.reject(new Error("WebAuthn disabled"));
					navigator.credentials.create = () => Promise.reject(new Error("WebAuthn disabled"));
				}
			});

			// Align browser headers with our mock user agent
			await this.browserContext!.setExtraHTTPHeaders({
				"Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
				"sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"Linux"',
			});

			// Navigate to the ship-track page to check auth state
			await requestQueue.enqueue(this.config.url, () => this.page!.goto(this.config.url, {
				waitUntil: "load",
				timeout: 60000,
			}));

			// Check if we are redirected to sign-in page
			console.log(`[AmazonLiveScraper] Navigation complete. URL is: ${this.page.url()}`);
			const isSignIn =
				this.page.url().includes("/ap/signin") ||
				(await this.page.$('input[name="email"]')) !== null;

			console.log(`[AmazonLiveScraper] Detected isSignIn state: ${isSignIn}`);

			if (isSignIn) {
				console.log(
					"[AmazonLiveScraper] Stored session invalid, attempting full login...",
				);
				console.log(`[AmazonLiveScraper] Current Page URL: ${this.page.url()}`);
				try {
					console.log(`[AmazonLiveScraper] Current Page Title: ${await this.page.title()}`);
				} catch (titleErr) {
					console.log("[AmazonLiveScraper] Failed to fetch page title:", titleErr);
				}

				const emailVal = creds.email || creds.username;
				if (!emailVal || !creds.password) {
					console.error(
						"[AmazonLiveScraper] Stored session expired and no email/password credentials provided.",
					);
					return false;
				}

				// Check for CAPTCHA first on email screen
				let hasCaptcha = (await this.page.$("input[name*='captcha'], img[src*='captcha'], #auth-captcha-image")) !== null;
				console.log(`[AmazonLiveScraper] CAPTCHA detected on email screen: ${hasCaptcha}`);
				if (hasCaptcha) {
					console.error("[AmazonLiveScraper] CAPTCHA detected on Amazon email login page. Headless scraping blocked.");
					const captchaPath = `/run/media/system/Data/Projects/nodejs/open-parcels/frontend/dist/captcha.png`;
					await this.page.screenshot({ path: captchaPath });
					return false;
				}

				// Fill in email with randomized human typing speed (40-120ms per key)
				await this.page.fill('input[name="email"]', "");
				await this.page.type('input[name="email"]', emailVal, { delay: Math.floor(Math.random() * 80) + 40 });
				await this.page.waitForTimeout(Math.random() * 500 + 200); // short natural pause

				await this.page.click("input#continue");
				await this.page.waitForTimeout(1500); // Wait for transition

				// Press Escape key twice to dismiss any native browser-level Passkey overlay dialogs
				await this.page.keyboard.press("Escape");
				await this.page.waitForTimeout(500);
				await this.page.keyboard.press("Escape");
				await this.page.waitForTimeout(500);

				// Log any visible alerts on the email submission transition
				try {
					const transitionAlert = await this.page.evaluate(() => {
						const alert = document.querySelector(".a-alert-content, .a-alert-heading, #auth-error-message-box, .a-alert-error");
						return alert ? alert.textContent?.trim() : null;
					});
					if (transitionAlert) {
						console.log(`[AmazonLiveScraper] Transition alert detected: "${transitionAlert}"`);
					}
				} catch (alertErr) {
					console.log("[AmazonLiveScraper] Failed to check for transition alerts:", alertErr);
				}

				// Automatically detect and click Passkey fallback "Use password instead"
				const fallbackClicked = await this.page.evaluate(() => {
					const anchors = Array.from(document.querySelectorAll("a, button"));
					const found = anchors.find(a => 
						a.id === "auth-signin-with-password" || 
						a.id === "passkey-signin-fallback" ||
						a.textContent?.toLowerCase().includes("stattdessen") ||
						a.textContent?.toLowerCase().includes("instead")
					);
					if (found) {
						(found as HTMLElement).click();
						return true;
					}
					return false;
				});

				if (fallbackClicked) {
					await this.page.waitForTimeout(1500);
				}
				
				// Wait up to 10 seconds for password field to appear dynamically
				await this.page.waitForSelector('input[name="password"]', { timeout: 10000 }).catch(() => {});
				await this.page.waitForTimeout(Math.random() * 1000 + 500); // 0.5s - 1.5s post-transition pause

				// Check for CAPTCHA on password screen
				hasCaptcha = (await this.page.$("input[name*='captcha'], img[src*='captcha'], #auth-captcha-image")) !== null;
				if (hasCaptcha) {
					console.error("[AmazonLiveScraper] CAPTCHA detected on Amazon password login page. Headless scraping blocked.");
					return false;
				}

				// Fill in password with human-like typing
				await this.page.fill('input[name="password"]', "");
				await this.page.type('input[name="password"]', creds.password, { delay: Math.floor(Math.random() * 80) + 40 });
				await this.page.waitForTimeout(Math.random() * 800 + 400); // pause before click

				await this.page.click("input#signInSubmit");
				await this.page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
				await this.page.waitForTimeout(2000);

				// Handle potential OTP/2FA request or manual intervention
				if (
					this.page.url().includes("approval") ||
					this.page.url().includes("cvf") ||
					this.page.url().includes("mfa")
				) {
					if (creds.otpSecret) {
						try {
							const otpCode = generateTOTP(creds.otpSecret);

							let filled = false;
							// Standard Multi-factor Auth page
							if (await this.page.$("input#auth-mfa-otpcode")) {
								await this.page.fill("input#auth-mfa-otpcode", otpCode);
								await this.page.click("input#auth-signin-button");
								filled = true;
							}
							// CVF page (e.g. email/SMS or authenticator OTP verification)
							else if (await this.page.$("input#ap_cvf_otpcode_input")) {
								await this.page.fill("input#ap_cvf_otpcode_input", otpCode);
								await this.page.click("input#ap_cvf_submit");
								filled = true;
							}
							else if (await this.page.$("input[name='code']")) {
								await this.page.fill("input[name='code']", otpCode);
								const submit = await this.page.$("input[type='submit'], button[type='submit']");
								if (submit) await submit.click();
								filled = true;
							}

							if (filled) {
								console.log("[AmazonLiveScraper] OTP submitted, waiting for navigation...");
								await this.page.waitForNavigation({
									waitUntil: "load",
									timeout: 30000,
								}).catch(() => {});
							} else {
								console.warn("[AmazonLiveScraper] Failed to identify OTP input field on the page.");
								return false;
							}
						} catch (totpErr) {
							console.error("[AmazonLiveScraper] Failed to generate or enter TOTP:", totpErr);
							return false;
						}
					} else {
						console.warn(
							"[AmazonLiveScraper] 2FA/OTP or Approval page encountered. Please complete it manually in browser or check credentials.",
						);
						return false;
					}
				}

				// Return to ship-track page after successful login
				console.log(`[AmazonLiveScraper] Returning to ship-track page: ${this.config.url}`);
				await requestQueue.enqueue(this.config.url, () => this.page!.goto(this.config.url, {
					waitUntil: "load",
					timeout: 60000,
				}));
			}

			// Check if authenticated successfully now
			const currentUrl = this.page.url();
			if (currentUrl.includes("/ap/signin")) {
				console.error(
					"[AmazonLiveScraper] Authentication failed. Redirected back to login.",
				);

				// Capture any error messages displayed on the Amazon login screen
				try {
					const errorMsg = await this.page.evaluate(() => {
						const alert = document.querySelector(".a-alert-content, .a-alert-heading, #auth-error-message-box, .a-alert-error");
						return alert ? alert.textContent?.trim() : null;
					});
					if (errorMsg) {
						console.error(`[AmazonLiveScraper] Amazon login page error message: "${errorMsg}"`);
					}
				} catch (err) {
					console.error("[AmazonLiveScraper] Failed to extract DOM error message:", err);
				}



				return false;
			}

			// Extract cookies and csrfToken
			const newCookies = await this.browserContext!.cookies();
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
	public async startLivePolling(parcelId: string, trackingNumber: string) {
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
		parcelId: string,
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
					vehicle: determineSingleEventVehicle(description, "In transit (Live)") !== "unknown"
						? determineSingleEventVehicle(description, "In transit (Live)")
						: "van",
					source: "Amazon Live Map",
				});
				await syncParcelStateFromEvents(parcelId);
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
	private async syncTimelineState(parcelId: string, trackingNumber: string) {
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
									vehicle: determineSingleEventVehicle(description, "Timeline Route") !== "unknown"
										? determineSingleEventVehicle(description, "Timeline Route")
										: "van",
									source: "Amazon Live Map",
								});
							}
						}
					}
					await syncParcelStateFromEvents(parcelId);
				}
			}
		} catch (err) {
			console.error(
				"[AmazonLiveScraper] Failed to sync timeline state history:",
				err,
			);
				};
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
