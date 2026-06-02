import { eq } from "drizzle-orm";
import { type BrowserContext, chromium, type Page } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { db } from "../../db";
import { credentials, parcelEvents, parcels } from "../../db/schema";
import { decryptCredential, encryptCredential } from "../../utils/crypto";
import { wsBroker } from "../websocket";
import { BaseScraper, type ScraperResult } from "./index";

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
			await this.page.goto(this.config.url, {
				waitUntil: "load",
				timeout: 60000,
			});

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
					console.log(`[AmazonLiveScraper] CAPTCHA screenshot saved to: ${captchaPath}`);
					return false;
				}

				// Fill in email with randomized human typing speed (40-120ms per key)
				console.log("[AmazonLiveScraper] Filling in email field...");
				await this.page.fill('input[name="email"]', "");
				await this.page.type('input[name="email"]', emailVal, { delay: Math.floor(Math.random() * 80) + 40 });
				await this.page.waitForTimeout(Math.random() * 500 + 200); // short natural pause

				console.log("[AmazonLiveScraper] Clicking Continue button...");
				await this.page.click("input#continue");
				console.log("[AmazonLiveScraper] Continue clicked. Waiting 1500ms for transition...");
				await this.page.waitForTimeout(1500); // Wait for transition
				console.log(`[AmazonLiveScraper] Post-continue URL: ${this.page.url()}`);

				// Press Escape key twice to dismiss any native browser-level Passkey overlay dialogs
				console.log("[AmazonLiveScraper] Pressing Escape keys to clear passkey overlay dialogs...");
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
				console.log("[AmazonLiveScraper] Checking for Passkey screen...");
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
					console.log("[AmazonLiveScraper] Passkey screen detected. Automatically clicked 'Use password instead' fallback!");
					await this.page.waitForTimeout(1500);
					console.log(`[AmazonLiveScraper] Post-passkey-fallback URL: ${this.page.url()}`);
				}
				
				// Wait up to 10 seconds for password field to appear dynamically
				console.log("[AmazonLiveScraper] Waiting for password field to be visible...");
				await this.page.waitForSelector('input[name="password"]', { timeout: 10000 }).catch(() => {
					console.log("[AmazonLiveScraper] Password field selector wait timed out.");
				});
				await this.page.waitForTimeout(Math.random() * 1000 + 500); // 0.5s - 1.5s post-transition pause

				// Check for CAPTCHA on password screen
				hasCaptcha = (await this.page.$("input[name*='captcha'], img[src*='captcha'], #auth-captcha-image")) !== null;
				console.log(`[AmazonLiveScraper] CAPTCHA detected on password screen: ${hasCaptcha}`);
				if (hasCaptcha) {
					console.error("[AmazonLiveScraper] CAPTCHA detected on Amazon password login page. Headless scraping blocked.");
					const captchaPath = `/run/media/system/Data/Projects/nodejs/open-parcels/frontend/dist/captcha.png`;
					await this.page.screenshot({ path: captchaPath });
					console.log(`[AmazonLiveScraper] CAPTCHA screenshot saved to: ${captchaPath}`);
					return false;
				}

				// Fill in password with human-like typing
				console.log("[AmazonLiveScraper] Filling in password field...");
				await this.page.fill('input[name="password"]', "");
				await this.page.type('input[name="password"]', creds.password, { delay: Math.floor(Math.random() * 80) + 40 });
				await this.page.waitForTimeout(Math.random() * 800 + 400); // pause before click

				console.log("[AmazonLiveScraper] Clicking Sign-In submit button...");
				await this.page.click("input#signInSubmit");
				console.log("[AmazonLiveScraper] Sign-In clicked. Waiting for load state...");
				await this.page.waitForLoadState("load", { timeout: 20000 }).catch(() => {
					console.log("[AmazonLiveScraper] waitForLoadState timed out or completed.");
				});
				await this.page.waitForTimeout(2000);
				console.log(`[AmazonLiveScraper] Post-submit URL: ${this.page.url()}`);

				// Handle potential OTP/2FA request or manual intervention
				if (
					this.page.url().includes("approval") ||
					this.page.url().includes("cvf") ||
					this.page.url().includes("mfa")
				) {
					console.log("[AmazonLiveScraper] Detected OTP/2FA or Approval page.");
					if (creds.otpSecret) {
						console.log("[AmazonLiveScraper] OTP/2FA page encountered, attempting auto-fill with TOTP...");
						try {
							const otpCode = generateTOTP(creds.otpSecret);
							console.log(`[AmazonLiveScraper] Generated TOTP token: ${otpCode}`);

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

				// Capture debug screenshot to let user inspect in the browser
				try {
					const debugPath = `/run/media/system/Data/Projects/nodejs/open-parcels/frontend/dist/captcha.png`;
					await this.page.screenshot({ path: debugPath });
					console.log(`[AmazonLiveScraper] Debug login state screenshot saved to: ${debugPath}`);
				} catch (err) {
					console.error("[AmazonLiveScraper] Failed to save failure screenshot:", err);
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

	public async scrapeTimeline(orderNo: string, trackingNumber: string): Promise<any> {
		const decrypted = await db
			.select()
			.from(credentials)
			.where(eq(credentials.service, "Amazon"))
			.limit(1);

		if (decrypted.length === 0) {
			throw new Error("No Amazon credentials found in database.");
		}

		const creds = JSON.parse(decryptCredential(decrypted[0].encryptedData));

		// Construct progress-tracker URL dynamically
		let trackingUrl = creds.urls?.[trackingNumber] || creds.shipTrackUrl;

		if (!trackingUrl && orderNo) {
			// If we don't have a cached tracking URL but have an order number,
			// navigate to the order details page first to resolve the correct shipmentId!
			trackingUrl = `https://www.amazon.de/gp/your-account/order-details?orderID=${orderNo}`;
		} else if (!trackingUrl) {
			trackingUrl = `https://www.amazon.de/progress-tracker/package?orderId=${orderNo}&packageIndex=0&shipmentId=${trackingNumber}&vt=NOTIFICATIONS`;
		}

		this.config.url = trackingUrl;

		console.log(`[AmazonLiveScraper] Initiating scrape at URL: ${trackingUrl}`);
		const success = await this.authenticate(creds);
		if (!success) {
			await this.close();
			throw new Error("Failed to authenticate with Amazon.");
		}

		if (!this.page) {
			await this.close();
			throw new Error("Browser page not initialized.");
		}

		// If we are on the order details page, resolve and click the tracking link
		if (this.page.url().includes("order-details")) {
			console.log("[AmazonLiveScraper] On order details page. Resolving tracking link...");
			const trackingLinkHref = await this.page.evaluate(() => {
				const links = Array.from(document.querySelectorAll("a"));
				const trackLink = links.find(a => 
					a.href.includes("progress-tracker") || 
					a.href.includes("ship-track") ||
					a.textContent?.toLowerCase().includes("verfolgen") ||
					a.textContent?.toLowerCase().includes("track")
				);
				return trackLink ? trackLink.href : null;
			});

			if (trackingLinkHref) {
				console.log(`[AmazonLiveScraper] Resolved real tracking link: ${trackingLinkHref}`);
				this.config.url = trackingLinkHref;

				// Cache resolved URL back into credentials DB for fast future refreshes
				try {
					if (!creds.urls) creds.urls = {};
					creds.urls[trackingNumber] = trackingLinkHref;
					const encrypted = encryptCredential(JSON.stringify(creds));
					await db
						.update(credentials)
						.set({
							encryptedData: encrypted,
							updatedAt: new Date(),
						})
						.where(eq(credentials.id, decrypted[0].id));
					console.log(`[AmazonLiveScraper] Cached real tracking URL for ${trackingNumber}`);
				} catch (cacheErr) {
					console.error("[AmazonLiveScraper] Failed to cache URL in database:", cacheErr);
				}

				// Navigate to the real progress tracker page
				await this.page.goto(trackingLinkHref, {
					waitUntil: "load",
					timeout: 60000,
				});
			} else {
				console.warn("[AmazonLiveScraper] Could not find any tracking links on the order details page.");
			}
		}

		console.log("[AmazonLiveScraper] Scraping tracking events from DOM...");

		// Try to click "Alle Aktualisierungen anzeigen" or similar button to expand detailed events list
		console.log("[AmazonLiveScraper] Checking for 'Alle Aktualisierungen anzeigen' (Show all updates) button natively...");
		const showAllUpdatesLocator = this.page.locator("a:has-text('Aktualisierungen'), a:has-text('updates'), a:has-text('Updates'), a:has-text('Updates anzeigen')");
		if (await showAllUpdatesLocator.count() > 0) {
			console.log("[AmazonLiveScraper] Found show all updates link natively. Clicking...");
			await showAllUpdatesLocator.first().click({ timeout: 5000 }).catch((clickErr) => {
				console.log("[AmazonLiveScraper] Native click failed, trying evaluate click fallback:", clickErr);
			});
			console.log("[AmazonLiveScraper] Click completed. Waiting 3000ms for updates container to load...");
			await this.page.waitForTimeout(3000);
		} else {
			console.log("[AmazonLiveScraper] Native show all updates link not found. Trying page.evaluate fallback click...");
			const clickedUpdates = await this.page.evaluate(() => {
				const elements = Array.from(document.querySelectorAll("a, button, span, div"));
				const target = elements.find(el => {
					const txt = el.textContent?.toLowerCase() || "";
					return txt.includes("aktualisierungen anzeigen") ||
						   txt.includes("see all updates") ||
						   txt.includes("show all updates");
				});
				if (target) {
					(target as HTMLElement).click();
					return true;
				}
				return false;
			});
			if (clickedUpdates) {
				console.log("[AmazonLiveScraper] Clicked 'Show all updates' via evaluate fallback. Waiting for updates container to load...");
				await this.page.waitForTimeout(3000);
			} else {
				console.log("[AmazonLiveScraper] 'Show all updates' button not found or not clickable in fallback.");
			}
		}
		
		// Wait for tracking content to render dynamically
		console.log("[AmazonLiveScraper] Waiting for tracking elements to render...");
		await this.page.waitForSelector('#primaryStatus, .primary-status, .track-package-status-box, #tracking-events-container, [id*="primaryStatus"], [id*="status"]', { timeout: 10000 }).catch((e) => {
			console.log("[AmazonLiveScraper] Warning: Timed out waiting for tracking container selectors. Proceeding with current DOM state.");
		});

		try {
			await this.page.screenshot({ path: '/run/media/system/Data/Projects/nodejs/open-parcels/frontend/dist/tracking_page.png' });
			console.log("[AmazonLiveScraper] Saved tracking page screenshot to frontend/dist/tracking_page.png");
		} catch (err) {
			console.error("[AmazonLiveScraper] Failed to take tracking page screenshot:", err);
		}

		console.log("[AmazonLiveScraper] Current URL before evaluating events:", this.page.url());
		const bodyText = await this.page.evaluate(() => document.body.innerText.slice(0, 1000));
		console.log("[AmazonLiveScraper] Page text preview:", bodyText);
		
		// Parse dates, times, descriptions, and locations from DOM
		const scrapedData = await this.page.evaluate(() => {
			const eventsList: Array<{ date: string; status: string; location?: string }> = [];
			
			// Select all day groups or rows
			const dayGroups = document.querySelectorAll(".a-spacing-double-large, .a-spacing-large, .tracking-event-group");
			
			if (dayGroups.length > 0) {
				for (const group of Array.from(dayGroups)) {
					const dateHeader = group.querySelector("h4, .a-size-medium, .event-date");
					if (!dateHeader) continue;
					const dateText = dateHeader.textContent?.trim() || "";
					
					const eventRows = group.querySelectorAll(".a-row, .event-details");
					for (const row of Array.from(eventRows)) {
						const timeEl = row.querySelector(".a-size-small, .event-time");
						const descEl = row.querySelector(".a-size-base, .event-description, b, strong");
						const locEl = row.querySelector(".a-color-secondary, .event-location, span[class*='secondary']");
						
						if (descEl && descEl.textContent?.trim()) {
							const timeText = timeEl ? ` ${timeEl.textContent.trim()}` : "";
							const descText = descEl.textContent.trim();
							const locText = locEl ? locEl.textContent.trim() : "";
							
							eventsList.push({
								date: `${dateText}${timeText}`,
								status: descText,
								location: locText || undefined
							});
						}
					}
				}
			} else {
				// Fallback: search for list items or text rows directly if dayGroups structure differs
				const genericRows = document.querySelectorAll(".a-spacing-medium .a-row");
				let currentDate = "";
				
				for (const row of Array.from(genericRows)) {
					const text = row.textContent?.trim() || "";
					const isHeader = row.querySelector("h4, .a-size-medium") || (!row.querySelector(".a-size-small") && text.match(/(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i));
					
					if (isHeader) {
						currentDate = text;
					} else {
						const timeEl = row.querySelector(".a-size-small, .event-time");
						const descEl = row.querySelector(".a-size-base, b, strong");
						const locEl = row.querySelector(".a-color-secondary");
						
						if (descEl && descEl.textContent?.trim()) {
							const timeText = timeEl ? ` ${timeEl.textContent.trim()}` : "";
							eventsList.push({
								date: `${currentDate || new Date().toDateString()}${timeText}`,
								status: descEl.textContent.trim(),
								location: locEl ? locEl.textContent.trim() : undefined
							});
						}
					}
				}
			}
			
			// Extract overall status
			let statusSlug = "sent";
			const timelineHeader = document.querySelector("h1, h2, .a-size-large, .tracking-object-state")?.textContent?.trim()?.toLowerCase() || "";
			if (timelineHeader.includes("zugestellt") || timelineHeader.includes("delivered") || timelineHeader.includes("geliefert")) {
				statusSlug = "delivered";
			} else if (timelineHeader.includes("heute") || timelineHeader.includes("today") || timelineHeader.includes("zustellung") || timelineHeader.includes("delivery")) {
				statusSlug = "arriving";
			} else if (timelineHeader.includes("bestellt") || timelineHeader.includes("ordered")) {
				statusSlug = "ordered";
			}
			
			return {
				events: eventsList,
				status: statusSlug,
				statusDescription: timelineHeader || "In transit"
			};
		});

		console.log("[AmazonLiveScraper] Raw Scraped Data Status:", scrapedData.status);
		console.log("[AmazonLiveScraper] Raw Scraped Data Status Description:", scrapedData.statusDescription);
		console.log("[AmazonLiveScraper] Raw Scraped Events:", JSON.stringify(scrapedData.events, null, 2));

		await this.close();

		// Convert date strings to standardized Dates
		const formattedEvents = scrapedData.events.map(ev => {
			let dateObj = new Date(ev.date);
			if (Number.isNaN(dateObj.getTime())) {
				// Parse German dates (e.g. "Dienstag, 2. Juni 02:14")
				// We can just fallback to current date for safety
				dateObj = new Date();
			}
			
			return {
				date: dateObj.toISOString(),
				status: ev.status,
				location: ev.location || undefined,
				description: ev.status
			};
		});

		return {
			trackingNumber,
			courier: "Amazon",
			status: scrapedData.status,
			statusDescription: scrapedData.statusDescription,
			events: formattedEvents
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
