import { eq } from "drizzle-orm";
import { db } from "../../db";
import { credentials, parcelEvents, parcels } from "../../db/schema";
import { extractLocationName, geocodeLocation } from "../../utils/geocoder";
import { AmazonLiveScraper } from "../scrapers/amazon-live-scraper";

export interface TrackingEventData {
	date: string;
	status: string;
	location?: string;
	description?: string;
}

export interface StandardizedTrackingData {
	trackingNumber: string;
	courier: string;
	status: string; // ordered, sent, arriving, delivered, return
	statusDescription?: string;
	estimatedDelivery?: string;
	lat?: number;
	lng?: number;
	events: TrackingEventData[];
	raw?: unknown;
}

export interface TrackingApiProvider {
	name: string;
	fetchTracking(
		trackingNumber: string,
	): Promise<StandardizedTrackingData | null>;
}

// JS-equivalent MurmurHash2 (32-bit) hashing function used by ParcelsApp API
function hash_32_gc(text: string, seed: number): number {
	let length = text.length;
	let h = seed ^ length;
	let i = 0;
	while (length >= 4) {
		let k =
			(text.charCodeAt(i) & 0xff) |
			((text.charCodeAt(i + 1) & 0xff) << 8) |
			((text.charCodeAt(i + 2) & 0xff) << 16) |
			((text.charCodeAt(i + 3) & 0xff) << 24);

		k = Math.imul(k, 1540483477);
		k ^= k >>> 24;
		k = Math.imul(k, 1540483477);

		h = Math.imul(h, 1540483477);
		h ^= k;

		length -= 4;
		i += 4;
	}

	switch (length) {
		case 3:
			h ^= (text.charCodeAt(i + 2) & 0xff) << 16;
			h ^= (text.charCodeAt(i + 1) & 0xff) << 8;
			h ^= text.charCodeAt(i) & 0xff;
			h = Math.imul(h, 1540483477);
			break;
		case 2:
			h ^= (text.charCodeAt(i + 1) & 0xff) << 8;
			h ^= text.charCodeAt(i) & 0xff;
			h = Math.imul(h, 1540483477);
			break;
		case 1:
			h ^= text.charCodeAt(i) & 0xff;
			h = Math.imul(h, 1540483477);
			break;
	}

	h ^= h >>> 13;
	h = Math.imul(h, 1540483477);
	h ^= h >>> 15;
	return h >>> 0;
}

export class ParcelsAppProvider implements TrackingApiProvider {
	name = "parcelsapp";

	async fetchTracking(
		trackingNumber: string,
	): Promise<StandardizedTrackingData | null> {
		const url = `https://parcelsapp.com/api/v1/parcels/${encodeURIComponent(trackingNumber)}/Auto%20Detect/en/Germany/Default/android`;

		const settings: (string | number | boolean)[] = [
			true, // Settings:push
			false, // Settings:subscribed
			1716723120000, // Settings:installedAt
			0, // Settings:goods
			5, // ReviewPromptStats:appOpens
			0, // totalParcels
			false, // dummy/ad-free
			"Pixel 6", // Model
			"oriole", // Device ID
			"89201f99c0d12e4f", // Unique ID
			"Google", // Manufacturer
			"com.android.vending", // Installer
			"3.0.2", // Readable Version
			trackingNumber, // Tracking Number
		];

		const jsonStr = JSON.stringify(settings);
		const hash = hash_32_gc(jsonStr, 978);
		settings.push(hash);

		const payload = [
			{
				slug: "ahkref",
				data: settings,
			},
		];

		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: {
					"User-Agent": "ParcelsApp/3.0 (Android)",
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(payload),
			});

			if (!resp.ok) {
				throw new Error(`HTTP error! Status: ${resp.status}`);
			}

			const raw = await resp.json();

			if (!raw || raw.error || !raw.states) {
				return null;
			}

			// Map delivered state
			let status = "sent";
			if (raw.delivered) {
				status = "delivered";
			} else if (raw.status?.toLowerCase().includes("today")) {
				status = "arriving";
			} else if (raw.status?.toLowerCase().includes("order")) {
				status = "ordered";
			}

			// Extract events
			const events: TrackingEventData[] = (raw.states || []).map(
				(s: {
					date?: string;
					status?: string;
					location?: string;
					description?: string;
				}) => ({
					date: s.date || new Date().toISOString(),
					status: s.status || "Status Update",
					location: s.location || undefined,
					description: s.description || undefined,
				}),
			);

			// Approximate coordinates if location can be geocoded or extract if exists
			let lat: number | undefined;
			let lng: number | undefined;

			// Some couriers return location coordinates. In parcelsapp response, we check if raw has locations or coordinates
			if (raw.lat && raw.lng) {
				lat = parseFloat(raw.lat);
				lng = parseFloat(raw.lng);
			}

			// Calculate estimated delivery
			let estimatedDelivery: string | undefined;
			if (raw.estimatedDeliveryDate) {
				estimatedDelivery = raw.estimatedDeliveryDate;
			} else if (raw.eta && typeof raw.eta === "object") {
				if (Array.isArray(raw.eta.period) && raw.eta.period.length > 0) {
					estimatedDelivery = raw.eta.period[0];
				} else if (typeof raw.eta.date === "string") {
					estimatedDelivery = raw.eta.date;
				}
			}

			return {
				trackingNumber: raw.trackingId || raw.tracking_id || trackingNumber,
				courier: raw.slug || raw.carrier || raw.origin || "Unknown",
				status,
				statusDescription: raw.statusDescription || raw.status || undefined,
				estimatedDelivery,
				lat,
				lng,
				events,
				raw,
			};
		} catch (err) {
			console.error("ParcelsApp fetch failed:", err);
			return null;
		}
	}
}

export class TrackingAggregator {
	private providers: TrackingApiProvider[] = [];

	constructor() {
		// Register the ParcelsApp free provider by default
		this.registerProvider(new ParcelsAppProvider());
	}

	registerProvider(provider: TrackingApiProvider) {
		this.providers.push(provider);
	}

	async aggregate(
		trackingNumber: string,
	): Promise<StandardizedTrackingData | null> {
		const promises = this.providers.map((p) =>
			p.fetchTracking(trackingNumber).catch((e) => {
				console.error(`Error fetching tracking from ${p.name}:`, e);
				return null;
			}),
		);

		const results = await Promise.all(promises);

		// Simple merging: first successful result wins
		for (const res of results) {
			if (res) {
				return res;
			}
		}

		return null;
	}
}

export const aggregator = new TrackingAggregator();

// Helper function to query provider and update DB
export async function trackAndUpdateParcel(parcelId: number): Promise<boolean> {
	const found = await db
		.select()
		.from(parcels)
		.where(eq(parcels.id, parcelId))
		.limit(1);
	if (found.length === 0) return false;

	const parcel = found[0];
	const trackingInfo = await aggregator.aggregate(parcel.trackingNumber);
	if (!trackingInfo) return false;

	// 1. Update parcel fields
	const updateData: {
		courier?: string;
		status?: string;
		updatedAt: Date;
		lat?: number | null;
		lng?: number | null;
		estimatedDeliveryStart?: Date | null;
	} = {
		courier: trackingInfo.courier,
		status: trackingInfo.status,
		updatedAt: new Date(),
	};

	if (trackingInfo.lat !== undefined) updateData.lat = trackingInfo.lat;
	if (trackingInfo.lng !== undefined) updateData.lng = trackingInfo.lng;

	// Try to geocode from events if coordinates are not provided directly by API
	if (updateData.lat === undefined || updateData.lat === null) {
		const sortedEventsDesc = [...trackingInfo.events].sort(
			(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
		);
		for (const ev of sortedEventsDesc) {
			let locationName = ev.location || null;
			if (!locationName && ev.description) {
				locationName = extractLocationName(ev.description);
			}
			if (!locationName && ev.status) {
				locationName = extractLocationName(ev.status);
			}

			if (locationName) {
				const coords = await geocodeLocation(locationName);
				if (coords) {
					updateData.lat = coords.lat;
					updateData.lng = coords.lng;
					break;
				}
			}
		}
	}

	if (trackingInfo.estimatedDelivery) {
		try {
			const d = new Date(trackingInfo.estimatedDelivery);
			if (!Number.isNaN(d.getTime())) {
				updateData.estimatedDeliveryStart = d;
			}
		} catch (_) {}
	}

	await db.update(parcels).set(updateData).where(eq(parcels.id, parcelId));

	// 2. Insert new events, preventing duplicates
	const existingEvents = await db
		.select()
		.from(parcelEvents)
		.where(eq(parcelEvents.parcelId, parcelId));
	const existingEventSignatures = new Set(
		existingEvents.map((e) => `${e.timestamp.getTime()}-${e.description}`),
	);

	for (const ev of trackingInfo.events) {
		const evDate = new Date(ev.date);
		const signature = `${evDate.getTime()}-${ev.description || ev.status}`;

		if (!existingEventSignatures.has(signature)) {
			let eventLat: number | null = null;
			let eventLng: number | null = null;

			let locationName = ev.location || null;
			if (!locationName && ev.description) {
				locationName = extractLocationName(ev.description);
			}
			if (!locationName && ev.status) {
				locationName = extractLocationName(ev.status);
			}

			if (locationName) {
				const coords = await geocodeLocation(locationName);
				if (coords) {
					eventLat = coords.lat;
					eventLng = coords.lng;
				}
			}

			await db.insert(parcelEvents).values({
				parcelId,
				location: ev.location || null,
				description: ev.description || ev.status,
				timestamp: evDate,
				lat: eventLat,
				lng: eventLng,
			});
		}
	}

	// 3. Amazon Live Polling check
	const updated = await db
		.select()
		.from(parcels)
		.where(eq(parcels.id, parcelId))
		.limit(1);
	if (updated.length > 0) {
		const currentParcel = updated[0];
		const isAmazon =
			(currentParcel.courier &&
				currentParcel.courier.toLowerCase() === "amazon") ||
			currentParcel.trackingNumber?.toLowerCase().startsWith("de");

		if (isAmazon && currentParcel.status === "arriving") {
			if (!AmazonLiveScraper.activeScrapers.has(parcelId)) {
				console.log(
					`[AmazonLiveScraper] Arriving status detected for Amazon parcel ${currentParcel.trackingNumber}. Initiating live tracking...`,
				);
				db.select()
					.from(credentials)
					.where(eq(credentials.service, "Amazon"))
					.limit(1)
					.then(async (amzCred) => {
						if (amzCred.length > 0) {
							const { decryptCredential } = require("../../utils/crypto");
							try {
								const decrypted = JSON.parse(
									decryptCredential(amzCred[0].encryptedData),
								);
								const trackingUrl =
									decrypted.urls?.[currentParcel.trackingNumber] ||
									decrypted.shipTrackUrl ||
									`https://www.amazon.de/gp/your-account/ship-track?itemId=ojpnrqkpmmstso&ref=ppx_yo2ov_dt_b_track_package&noPtRedirect=1&orderId=305-1971589-6669167&shipmentId=Tg9BCngFb`;

								const scraper = new AmazonLiveScraper({
									serviceName: "Amazon",
									url: trackingUrl,
								});

								const success = await scraper.authenticate(decrypted);
								if (success) {
									scraper.startLivePolling(
										parcelId,
										currentParcel.trackingNumber,
									);
								} else {
									console.error(
										"[AmazonLiveScraper] Failed to authenticate live tracking session.",
									);
									await scraper.close();
								}
							} catch (err) {
								console.error(
									"[AmazonLiveScraper] Failed to initialize live tracking:",
									err,
								);
							}
						} else {
							console.warn(
								"[AmazonLiveScraper] No Amazon credentials found in DB. Skipping live tracking.",
							);
						}
					})
					.catch((err) => {
						console.error(
							"[AmazonLiveScraper] Error loading credentials:",
							err,
						);
					});
			}
		}
	}

	return true;
}
