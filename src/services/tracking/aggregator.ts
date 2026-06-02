import { eq } from "drizzle-orm";
import { db } from "../../db";
import { credentials, orderParcels, orders, parcelEvents, parcels } from "../../db/schema";
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

// ---------------------------------------------------------------------------
// Minopia Lookup Provider
// Calls LOOKUP_URL/api/parcel/{trackingNumber} to resolve tracking info.
//
// The API response shape differs by carrier. Known variants:
//   - carrier: number (e.g. 2) or string (e.g. "DHL")
//   - status:  normalized slug ("pickup") OR raw carrier text ("Zustellung erfolgreich.")
//   - delivered: boolean (present on some carriers, absent on others)
//   - is_return: boolean (present on some carriers)
//   - estimated_delivery: object with period[] (present on some carriers)
//   - couriers: string[] (always present when success=true)
// ---------------------------------------------------------------------------

/**
 * Resolves the internal status from the Minopia response.
 * Prioritizes the structured boolean flags over free-text status strings.
 */
function resolveMinopiaStatus(r: {
	delivered?: boolean;
	is_return?: boolean;
	status?: string;
	estimated_delivery?: { status?: string };
}): string {
	// Most reliable: boolean flags
	if (r.is_return === true) return "return";
	if (r.delivered === true) return "delivered";

	// Second most reliable: normalized status on estimated_delivery object
	const edStatus = r.estimated_delivery?.status?.toLowerCase() ?? "";
	if (edStatus === "pickup" || edStatus === "delivered") return "delivered";
	if (edStatus === "out_for_delivery" || edStatus === "delivery") return "arriving";
	if (edStatus === "in_transit") return "sent";
	if (edStatus === "ordered" || edStatus === "pending") return "ordered";

	// Fallback: keyword match on the raw status string (may be in any language)
	const rawStatus = (r.status ?? "").toLowerCase();
	if (
		rawStatus.includes("zugestellt") ||
		rawStatus.includes("delivered") ||
		rawStatus === "pickup"
	) return "delivered";
	if (rawStatus.includes("unterwegs") || rawStatus.includes("out for delivery")) return "arriving";
	if (rawStatus.includes("return") || rawStatus.includes("rücksendung")) return "return";

	return "sent";
}

export class UniversalLookupProvider implements TrackingApiProvider {
	name = "minopia";

	private get baseUrls(): string[] {
		const raw = process.env.LOOKUP_URL ?? "";
		if (!raw.trim()) return [];
		return raw.split(",").map((url) => url.trim().replace(/\/+$/, ""));
	}

	async fetchTracking(
		trackingNumber: string,
	): Promise<StandardizedTrackingData | null> {
		const urls = this.baseUrls;
		if (urls.length === 0) {
			console.warn(
				"[UniversalLookupProvider] LOOKUP_URL is not set — skipping lookup.",
			);
			return null;
		}

		let body: any = null;
		let lastError: Error | null = null;

		for (const baseUrl of urls) {
			const url = `${baseUrl}/api/parcel/${encodeURIComponent(trackingNumber)}?fresh=true`;
			try {
				const resp = await fetch(url, {
					headers: {
						"User-Agent": "OpenParcels/1.0.0 (self-hosted parcel tracker)",
						Accept: "application/json",
					},
				});

				if (!resp.ok) {
					throw new Error(`HTTP ${resp.status} from ${resp.url}`);
				}

				const resBody = await resp.json();

				if (!resBody?.success || !resBody?.response) {
					console.warn(
						`[UniversalLookupProvider] Unsuccessful response for ${trackingNumber} from ${baseUrl}:`,
						resBody?.errors || resBody,
					);
					continue;
				}

				body = resBody;
				break; // Successfully got tracking data
			} catch (err: any) {
				console.warn(
					`[UniversalLookupProvider] Failed to fetch tracking for ${trackingNumber} from ${baseUrl}:`,
					err.message || err,
				);
				lastError = err;
			}
		}

		if (!body) {
			if (lastError) {
				console.error(
					`[UniversalLookupProvider] All lookup URLs failed for ${trackingNumber}. Last error:`,
					lastError,
				);
			}
			return null;
		}

		try {
			const r = body.response as {
				tracking_number?: string;
				carrier?: number | string;
				status?: string;
				status_description?: string;
				delivered?: boolean;
				is_return?: boolean;
				couriers?: string[];
				estimated_delivery?: {
					status?: string;
					period?: string[];
				};
				events?: {
					date?: string;
					status?: string;
					location?: string;
					courier?: string;
					is_return?: boolean;
				}[];
			};

			const status = resolveMinopiaStatus(r);

			// carrier may be a number (internal ID) or a string name — prefer couriers[] or string carrier
			const courierName =
				typeof r.carrier === "string"
					? r.carrier
					: Array.isArray(r.couriers) && r.couriers.length > 0
						? r.couriers[0]
						: undefined;
			const courier = courierName ?? r.status_description ?? "Unknown";

			// Extract estimated delivery from period array if present
			let estimatedDelivery: string | undefined;
			if (Array.isArray(r.estimated_delivery?.period) && r.estimated_delivery!.period!.length > 0) {
				estimatedDelivery = r.estimated_delivery!.period![0];
			}

			const events: TrackingEventData[] = (r.events ?? []).map((ev) => ({
				date: ev.date ?? new Date().toISOString(),
				status: ev.status ?? "Status Update",
				location: ev.location ?? undefined,
				description: ev.status ?? undefined,
			}));

			return {
				trackingNumber: r.tracking_number ?? trackingNumber,
				courier,
				status,
				statusDescription: r.status_description,
				events,
				raw: body,
			};
		} catch (err) {
			console.error(
				`[UniversalLookupProvider] Failed to fetch tracking for ${trackingNumber}:`,
				err,
			);
			return null;
		}
	}
}

export class TrackingAggregator {
	private providers: TrackingApiProvider[] = [];

	constructor() {
		this.registerProvider(new UniversalLookupProvider());
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
	const isAmazon =
		(parcel.courier && parcel.courier.toLowerCase() === "amazon") ||
		parcel.trackingNumber?.toLowerCase().startsWith("de");

	let trackingInfo: any = null;

	if (isAmazon) {
		const amzCred = await db
			.select()
			.from(credentials)
			.where(eq(credentials.service, "Amazon"))
			.limit(1);
		
		if (amzCred.length > 0) {
			console.log(`[Tracking] Amazon package detected. Launching local scraper for ${parcel.trackingNumber}...`);
			try {
				// Find linked order number
				const links = await db
					.select()
					.from(orderParcels)
					.where(eq(orderParcels.parcelId, parcelId))
					.limit(1);
				
				let orderNo = "";
				if (links.length > 0) {
					const ord = await db
						.select()
						.from(orders)
						.where(eq(orders.id, links[0].orderId))
						.limit(1);
					if (ord.length > 0) {
						orderNo = ord[0].orderNumber;
					}
				}

				const scraper = new AmazonLiveScraper({
					serviceName: "Amazon",
					url: "",
				});
				
				trackingInfo = await scraper.scrapeTimeline(orderNo, parcel.trackingNumber);
				console.log(`[Tracking] Amazon local scraper finished successfully. Found ${trackingInfo.events.length} events.`);
			} catch (err) {
				console.error("[Tracking] Local Amazon scraper failed:", err);
			}
		}
	}

	if (!trackingInfo) {
		trackingInfo = await aggregator.aggregate(parcel.trackingNumber);
	}

	if (!trackingInfo) return false;

	// Check if the tracking info is recycled:
	// If the status is "delivered" but the last event timestamp is older than when the parcel was created (with a 12-hour grace period for timezones/clock differences),
	// ignore the tracking data and preserve the parcel's status (e.g. keeping it as "ordered" / "sent" / whatever it was).
	const lastEventDate = trackingInfo.events.length > 0
		? new Date(trackingInfo.events[trackingInfo.events.length - 1].date)
		: null;

	const isRecycled = lastEventDate &&
		trackingInfo.status === "delivered" &&
		lastEventDate.getTime() < parcel.createdAt.getTime() - 30 * 24 * 60 * 60 * 1000;

	if (isRecycled) {
		console.warn(
			`[Tracking] Reused/recycled tracking number detected for ${parcel.trackingNumber}. ` +
			`Tracking returns 'delivered' on ${lastEventDate.toISOString()} but parcel was created on ${parcel.createdAt.toISOString()}. Ignoring tracking updates.`,
		);
		return true;
	}

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

	// Geocode from events if coordinates are not provided directly by the API
	if (updateData.lat === undefined || updateData.lat === null) {
		const sortedEventsDesc = [...trackingInfo.events].sort(
			(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
		);
		for (const ev of sortedEventsDesc) {
			let locationName = ev.location || null;
			if (!locationName && ev.description) locationName = extractLocationName(ev.description);
			if (!locationName && ev.status) locationName = extractLocationName(ev.status);
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
			if (!locationName && ev.description) locationName = extractLocationName(ev.description);
			if (!locationName && ev.status) locationName = extractLocationName(ev.status);
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
