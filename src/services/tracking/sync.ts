import { eq } from "drizzle-orm";
import { db } from "../../db";
import { parcels, parcelEvents } from "../../db/schema";

export async function syncParcelStateFromEvents(parcelId: number): Promise<void> {
	const events = await db
		.select()
		.from(parcelEvents)
		.where(eq(parcelEvents.parcelId, parcelId));

	if (events.length === 0) return;

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

	const updateData: {
		status: string;
		lat: number | null;
		lng: number | null;
		updatedAt: Date;
	} = {
		status: determinedStatus,
		lat: null,
		lng: null,
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
