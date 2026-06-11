import { eq } from "drizzle-orm";
import { db } from "../../db";
import { credentials, orders, parcelEvents, parcels } from "../../db/schema";
import { extractLocationName, geocodeLocation, isLikelyLocation } from "../../utils/geocoder";
import { AmazonLiveScraper } from "../scrapers/amazon-live-scraper";
import { requestQueue } from "../../utils/requestQueue";
import { syncParcelStateFromEvents, determineSingleEventVehicle } from "./sync";

export interface TrackingEventData {
	date: string;
	status: string;
	location?: string;
	description?: string;
	source?: string;
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
// UniversalLookup Provider
// Calls LOOKUP_URLS/api/parcel/{trackingNumber} to resolve tracking info.
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
 * Resolves the internal status from the UniversalLookup response.
 * Prioritizes the structured boolean flags over free-text status strings.
 */
function resolveUniversalLookupStatus(r: {
	delivered?: boolean;
	is_return?: boolean;
	status?: string;
	estimated_delivery?: { status?: string };
	events?: { status?: string }[];
}): string {
	// Most reliable: boolean flags
	if (r.is_return === true) return "return";
	if (r.delivered === true) return "delivered";

	// Check latest event for precise state
	const latestEvent = r.events && r.events.length > 0 ? r.events[r.events.length - 1] : null;
	const latestDesc = (latestEvent?.status ?? "").toLowerCase();

	const isPickupReady = (
		latestDesc.includes("abholbereit") ||
		latestDesc.includes("bereit zur abholung") ||
		latestDesc.includes("available for pickup") ||
		latestDesc.includes("ready for pickup") ||
		latestDesc.includes("bereitgestellt") ||
		latestDesc === "pickup"
	) && !(
		latestDesc.includes("shortly") ||
		latestDesc.includes("in kürze") ||
		latestDesc.includes("bald")
	);

	if (isPickupReady) return "pickup";

	// Second most reliable: normalized status on estimated_delivery object
	const edStatus = r.estimated_delivery?.status?.toLowerCase() ?? "";
	if (edStatus === "delivered") return "delivered";
	if (edStatus === "pickup") return "pickup";
	if (edStatus === "out_for_delivery" || edStatus === "delivery") return "arriving";
	if (edStatus === "in_transit") return "sent";
	if (edStatus === "ordered" || edStatus === "pending") return "ordered";

	// Fallback: keyword match on the raw status string (may be in any language)
	const rawStatus = (r.status ?? "").toLowerCase();
	if (
		rawStatus.includes("zugestellt") ||
		rawStatus.includes("delivered")
	) return "delivered";
	if (
		rawStatus.includes("unterwegs") ||
		rawStatus.includes("out for delivery")
	) return "arriving";
	if (rawStatus === "pickup") return "pickup";
	if (rawStatus.includes("return") || rawStatus.includes("rücksendung")) return "return";

	return "sent";
}

export class UniversalLookupProvider implements TrackingApiProvider {
	name = "universal-lookup";

	private get baseUrls(): string[] {
		const raw = process.env.LOOKUP_URLS ?? "";
		if (!raw.trim()) return [];
		return raw.split(",").map((url) => url.trim().replace(/\/+$/, ""));
	}

	private async fetchJson(apiPath: string): Promise<any> {
		const urls = this.baseUrls;
		for (const baseUrl of urls) {
			const url = `${baseUrl}/api/v1/${apiPath}?fresh=true&wait=1`;
			try {
				const resp = await requestQueue.enqueue(url, () => fetch(url, {
					headers: {
						"User-Agent": "OpenParcels/1.0.0 (self-hosted parcel tracker)",
						Accept: "application/json",
					},
				}));
				if (resp.ok) {
					return await resp.json();
				}
			} catch (err: any) {
				console.warn(`[UniversalLookupProvider] Failed to fetch ${apiPath} from ${baseUrl}:`, err.message || err);
			}
		}
		return null;
	}

	async fetchTracking(
		trackingNumber: string,
	): Promise<StandardizedTrackingData | null> {
		const urls = this.baseUrls;
		if (urls.length === 0) {
			console.warn(
				"[UniversalLookupProvider] LOOKUP_URLS is not set — skipping lookup.",
			);
			return null;
		}

		// Detect order IDs to route through the multi-step order→parcel flow
		let orderId = "";
		let subQuery = "";

		if (trackingNumber.includes("::")) {
			const parts = trackingNumber.split("::");
			orderId = parts[0];
			subQuery = parts[1];
		} else if (trackingNumber.match(/^\d{3}-\d{7}-\d{6,7}$/)) {
			// Amazon order format: 123-4567890-1234567
			orderId = trackingNumber;
		} else if (trackingNumber.match(/^\d{16}$/)) {
			// AliExpress order format: 16 numeric digits
			orderId = trackingNumber;
		} else if (trackingNumber.startsWith("http")) {
			try {
				const parsed = new URL(trackingNumber);
				orderId = parsed.searchParams.get("orderId") || parsed.searchParams.get("orderID") || "";
				subQuery = parsed.searchParams.get("shipmentId") || parsed.searchParams.get("trackingId") || "";
			} catch (_) {}
		}

		if (orderId) {
			console.log(`[UniversalLookupProvider] Running multi-step lookup flow for order: ${orderId}, subQuery: ${subQuery}`);
			// Step 1: Lookup order
			const orderData = await this.fetchJson(`order/${orderId}`);
			if (orderData?.success && orderData?.response) {
				const orderResp = orderData.response;
				const shipments: any[] = orderResp.shipments || [];

				const allEvents: any[] = [];
				let finalStatus = "ordered";
				let finalStatusDesc = orderResp.status_description || orderResp.status || "Ordered";
				let finalCourier = orderResp.carrier || "Unknown";
				let finalTrackingNumber = trackingNumber;
				let finalEstimatedDelivery = "";

				// If the order response already contains the carrier tracking number directly
				// (e.g. AliExpress), skip the shipment URL step and go straight to parcel lookup
				const directTrackingNumber =
					(orderResp.tracking_numbers as string[] | undefined)?.[0] ||
					(shipments[0]?.tracking_id as string | undefined);

				if (directTrackingNumber && !directTrackingNumber.match(/^\d{3}-\d{7}-\d{6,7}$/) && !directTrackingNumber.match(/^\d{16}$/)) {
					// It looks like a real carrier tracking number — go straight to parcel lookup
					console.log(`[UniversalLookupProvider] Order ${orderId} has direct tracking number: ${directTrackingNumber}. Skipping shipment step.`);
					finalTrackingNumber = directTrackingNumber;
					if (shipments[0]?.carrier) finalCourier = shipments[0].carrier;

					const parcelData = await this.fetchJson(`parcel/${encodeURIComponent(directTrackingNumber)}`);
					if (parcelData?.success && parcelData?.response) {
						const pr = parcelData.response;
						if (pr.couriers?.length) finalCourier = pr.couriers[0];
						if (pr.status_description) finalStatusDesc = pr.status_description;
						if (pr.status) finalStatus = pr.status;
						if (pr.estimated_delivery) finalEstimatedDelivery = pr.estimated_delivery;
						if (Array.isArray(pr.events)) {
							allEvents.push(...pr.events.map((e: any) => ({ ...e, source: finalCourier })));
						}
					}

					const status = resolveUniversalLookupStatus({ status: finalStatus });
					return {
						trackingNumber: finalTrackingNumber,
						courier: finalCourier,
						status,
						statusDescription: finalStatusDesc,
						estimatedDelivery: finalEstimatedDelivery || undefined,
						events: allEvents,
						raw: orderData,
					};
				}

				const targetShipments = subQuery
					? shipments.filter((s: any) => s.tracking_id === subQuery || s.tracking_url?.includes(subQuery))
					: shipments;

				// Step 2: Iterate through shipments
				for (const shipment of targetShipments) {
					if (!shipment.tracking_url) continue;

					// Lookup shipment using tracking_url
					const shipmentData = await this.fetchJson(`shipment/${encodeURIComponent(shipment.tracking_url)}`);
					if (shipmentData?.success && shipmentData?.response) {
						const shipmentResp = shipmentData.response;
						const carrierTrackingNumber = shipmentResp.tracking_number;

						if (Array.isArray(shipmentResp.events)) {
							allEvents.push(...shipmentResp.events.map((e: any) => ({ ...e, source: "Amazon" })));
						}
						if (shipmentResp.status_description) finalStatusDesc = shipmentResp.status_description;
						if (shipmentResp.status) finalStatus = shipmentResp.status;
						if (shipmentResp.estimated_delivery) finalEstimatedDelivery = shipmentResp.estimated_delivery;

						// Step 3: Lookup parcel using tracking number from shipment if available
						if (carrierTrackingNumber && carrierTrackingNumber !== shipment.tracking_id) {
							finalTrackingNumber = carrierTrackingNumber;
							const parcelData = await this.fetchJson(`parcel/${encodeURIComponent(carrierTrackingNumber)}`);
							if (parcelData?.success && parcelData?.response) {
								const parcelResp = parcelData.response;
								if (parcelResp.couriers && parcelResp.couriers.length > 0) {
									finalCourier = parcelResp.couriers[0];
								}
								if (parcelResp.status_description) {
									finalStatusDesc = parcelResp.status_description;
								}
								if (parcelResp.status) {
									finalStatus = parcelResp.status;
								}
								if (parcelResp.estimated_delivery) {
									finalEstimatedDelivery = parcelResp.estimated_delivery;
								}
								if (Array.isArray(parcelResp.events)) {
									allEvents.push(...parcelResp.events.map((e: any) => ({ ...e, source: finalCourier })));
								}
							}
						}
					}
				}

				const status = resolveUniversalLookupStatus({
					status: finalStatus,
					status_description: finalStatusDesc,
				} as any);

				const uniqueEventsMap = new Map<string, TrackingEventData>();
				for (const ev of allEvents) {
					const dateStr = ev.date || new Date().toISOString();
					const desc = ev.status || ev.description || "Status Update";
					const sig = `${new Date(dateStr).getTime()}-${desc}`;
					uniqueEventsMap.set(sig, {
						date: dateStr,
						status: desc,
						location: ev.location || undefined,
						description: desc,
						source: ev.source || ev.courier || finalCourier,
					});
				}

				const events = Array.from(uniqueEventsMap.values()).sort(
					(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
				);

				return {
					trackingNumber: finalTrackingNumber,
					courier: finalCourier,
					status,
					statusDescription: finalStatusDesc,
					estimatedDelivery: finalEstimatedDelivery || undefined,
					events,
					raw: orderData,
				};
			}
		}

		// Fallback to standard parcel lookup
		let body: any = null;
		let lastError: Error | null = null;

		for (const baseUrl of urls) {
			const url = `${baseUrl}/api/v1/parcel/${encodeURIComponent(trackingNumber)}?fresh=true&wait=1`;
			try {
				const resp = await requestQueue.enqueue(url, () => fetch(url, {
					headers: {
						"User-Agent": "OpenParcels/1.0.0 (self-hosted parcel tracker)",
						Accept: "application/json",
					},
				}));

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
				break;
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

			const status = resolveUniversalLookupStatus(r);

			const courierName =
				typeof r.carrier === "string"
					? r.carrier
					: Array.isArray(r.couriers) && r.couriers.length > 0
						? r.couriers[0]
						: undefined;
			const courier = courierName ?? r.status_description ?? "Unknown";

			let estimatedDelivery: string | undefined;
			if (Array.isArray(r.estimated_delivery?.period) && r.estimated_delivery!.period!.length > 0) {
				estimatedDelivery = r.estimated_delivery!.period![0];
			}

			const events: TrackingEventData[] = (r.events ?? []).map((ev) => ({
				date: ev.date ?? new Date().toISOString(),
				status: ev.status ?? "Status Update",
				location: ev.location ?? undefined,
				description: ev.status ?? undefined,
				source: ev.courier || courier,
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
export async function trackAndUpdateParcel(parcelId: string): Promise<boolean> {
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

	// AliExpress order ID is 16 numeric digits, or courier is explicitly "aliexpress"
	const isAliExpress =
		(parcel.courier && parcel.courier.toLowerCase() === "aliexpress") ||
		/^\d{16}$/.test(parcel.trackingNumber || "");

	let trackingInfo: any = null;

	// For marketplace orders (Amazon, AliExpress) where the tracking number stored
	// is the order ID, look up the linked order to build the correct lookup query.
	if (isAmazon || isAliExpress) {
		let orderNo = "";
		if (parcel.orderId) {
			const ord = await db
				.select()
				.from(orders)
				.where(eq(orders.id, parcel.orderId))
				.limit(1);
			if (ord.length > 0) {
				orderNo = ord[0].orderNumber;
			}
		}

		if (isAmazon) {
			// Amazon needs the compound orderNo::shipmentId form
			trackingInfo = await aggregator.aggregate(orderNo ? `${orderNo}::${parcel.trackingNumber}` : parcel.trackingNumber);
		} else {
			// AliExpress: the order ID itself is the lookup key (16-digit)
			trackingInfo = await aggregator.aggregate(orderNo || parcel.trackingNumber);
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
		lastEventDate.getTime() < parcel.addedAt.getTime() - 30 * 24 * 60 * 60 * 1000;

	if (isRecycled) {
		console.warn(
			`[Tracking] Reused/recycled tracking number detected for ${parcel.trackingNumber}. ` +
			`Tracking returns 'delivered' on ${lastEventDate.toISOString()} but parcel was created on ${parcel.addedAt.toISOString()}. Ignoring tracking updates.`,
		);
		return true;
	}

	// 1. Update parcel fields
	const updateData: {
		name?: string | null;
		trackingNumber?: string;
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

	if (!parcel.name && trackingInfo.itemName) {
		updateData.name = trackingInfo.itemName;
	}

	if (trackingInfo.trackingNumber && trackingInfo.trackingNumber !== parcel.trackingNumber) {
		updateData.trackingNumber = trackingInfo.trackingNumber;
	}

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

			let locationName = (ev.location && isLikelyLocation(ev.location)) ? ev.location : null;
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
				location: locationName,
				description: ev.description || ev.status,
				timestamp: evDate,
				lat: eventLat,
				lng: eventLng,
				vehicle: determineSingleEventVehicle(ev.description || ev.status, locationName),
				source: ev.source || trackingInfo.courier || null,
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
					.then(async (amzCreds) => {
						if (amzCreds.length > 0) {
							const { decryptCredential } = require("../../utils/crypto");
							try {
								// Find the credential that matches this tracking number in its urls map
								let selectedCred = amzCreds[0];
								let decrypted: any = null;

								for (const cred of amzCreds) {
									try {
										const dec = JSON.parse(decryptCredential(cred.encryptedData));
										if (dec.urls?.[currentParcel.trackingNumber]) {
											selectedCred = cred;
											decrypted = dec;
											break;
										}
									} catch (_) {}
								}

								if (!decrypted) {
									decrypted = JSON.parse(decryptCredential(selectedCred.encryptedData));
								}

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

	await syncParcelStateFromEvents(parcelId);

	return true;
}
