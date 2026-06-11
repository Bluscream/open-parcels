import { eq } from "drizzle-orm";
import { db } from "../../db";
import { parcels, parcelEvents } from "../../db/schema";

export function determineSingleEventVehicle(description: string, location?: string | null): string {
	const text = `${description || ""} ${location || ""}`.toLowerCase();
	const planeWords = ["plane", "flight", "air", "aircraft", "airplane", "flug", "luft", "flying"];
	// Use whole-word matching for ship to avoid false positives from "shipment", "shipping", etc.
	const shipWords = ["\\bship\\b", "\\bboat\\b", "\\bschiff\\b", "\\bboot\\b", "\\bocean\\b", "\\bsea\\b", "\\bvessel\\b", "\\bcontainer\\b", "\\bport\\b"];
	const heliWords = ["helicopter", "heli", "hubschrauber"];
	const trainWords = ["train", "rail", "bahn", "zug", "railway"];
	const bikeWords = ["bike", "bicycle", "fahrrad", "cycling", "radfahrer"];
	const vanWords = ["van", "delivery vehicle", "zustellfahrzeug", "delivery", "carrier", "courier", "post", "filiale", "outlet"];
	const truckWords = ["truck", "lkw", "hauler", "laster", "freight", "cargo", "transit", "sorting", "road", "vehicle", "fahrzeug"];

	if (planeWords.some(w => text.includes(w))) return "plane";
	if (shipWords.some(w => new RegExp(w).test(text))) return "ship";
	if (heliWords.some(w => text.includes(w))) return "heli";
	if (trainWords.some(w => text.includes(w))) return "train";
	if (bikeWords.some(w => text.includes(w))) return "bike";
	if (vanWords.some(w => text.includes(w))) return "van";
	if (truckWords.some(w => text.includes(w))) return "truck";
	return "unknown";
}

export async function syncParcelStateFromEvents(parcelId: number): Promise<void> {
	const events = await db
		.select()
		.from(parcelEvents)
		.where(eq(parcelEvents.parcelId, parcelId));

	if (events.length === 0) return;

	// Backfill/sync vehicles for any event that doesn't have it set in DB
	for (const event of events) {
		if (!event.vehicle) {
			const parsedVehicle = determineSingleEventVehicle(event.description, event.location);
			if (parsedVehicle !== "unknown") {
				event.vehicle = parsedVehicle;
				await db
					.update(parcelEvents)
					.set({ vehicle: parsedVehicle })
					.where(eq(parcelEvents.id, event.id));
			}
		}
	}

	// Sort events: most recent first (by timestamp descending, then id descending as fallback)
	const sortedEvents = [...events].sort(
		(a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.id - a.id
	);

	const latestEvent = sortedEvents[0];

	// Determine status from the latest event description, location, or source
	const textToAnalyze = `${latestEvent.description || ""} ${latestEvent.location || ""}`.toLowerCase();

	let determinedStatus: string = "sent";
	if (
		textToAnalyze.includes("delivered") ||
		textToAnalyze.includes("zugestellt") ||
		textToAnalyze.includes("successfully") ||
		textToAnalyze.includes("abgeholt") ||
		textToAnalyze.includes("picked up") ||
		textToAnalyze.includes("pickup") ||
		textToAnalyze.includes("delivery successful") ||
		textToAnalyze.includes("bereit zur abholung") ||
		textToAnalyze.includes("ready for pickup") ||
		textToAnalyze.includes("delivered to") ||
		textToAnalyze.includes("successful delivery")
	) {
		determinedStatus = "delivered";
	} else if (
		textToAnalyze.includes("return") ||
		textToAnalyze.includes("rücksendung") ||
		textToAnalyze.includes("returned")
	) {
		determinedStatus = "return";
	} else if (
		textToAnalyze.includes("out for delivery") ||
		textToAnalyze.includes("zustellung heute") ||
		textToAnalyze.includes("arriving") ||
		textToAnalyze.includes("delivery") ||
		textToAnalyze.includes("unterwegs") ||
		textToAnalyze.includes("in transit")
	) {
		determinedStatus = "arriving";
	}

	// Find the most recent event that has a determined vehicle (not unknown/null)
	const eventWithVehicle = sortedEvents.find(e => e.vehicle && e.vehicle !== "unknown");
	const determinedVehicle = eventWithVehicle?.vehicle || "unknown";

	const updateData: {
		status: string;
		lat: number | null;
		lng: number | null;
		lastVehicle: string;
		lastEventDescription: string | null;
		updatedAt: Date;
	} = {
		status: determinedStatus,
		lat: null,
		lng: null,
		lastVehicle: determinedVehicle,
		lastEventDescription: latestEvent.description || null,
		updatedAt: new Date(),
	};

	// Get coordinates from the latest event if it has them
	if (latestEvent.lat !== null && latestEvent.lat !== undefined) {
		updateData.lat = latestEvent.lat;
		updateData.lng = latestEvent.lng;
	} else {
		// Fallback: search for the most recent event that does have coordinates
		const eventWithCoords = sortedEvents.find(e => e.lat !== null && e.lat !== undefined);
		if (eventWithCoords) {
			updateData.lat = eventWithCoords.lat;
			updateData.lng = eventWithCoords.lng;
		}
	}

	await db
		.update(parcels)
		.set(updateData)
		.where(eq(parcels.id, parcelId));
}
