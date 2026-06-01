// Quick offline dictionary of common parcel hubs/cities to ensure instant, network-resilient lookups
const OFFLINE_GEO_DB: Record<string, { lat: number; lng: number }> = {
	mainz: { lat: 49.9929, lng: 8.2473 },
	"münster-osnabrück": { lat: 52.1345, lng: 7.6848 },
	münster: { lat: 51.9607, lng: 7.6261 },
	osnabrück: { lat: 52.2799, lng: 8.0472 },
	berlin: { lat: 52.52, lng: 13.405 },
	hamburg: { lat: 53.5511, lng: 9.9937 },
	münchen: { lat: 48.1351, lng: 11.582 },
	munich: { lat: 48.1351, lng: 11.582 },
	köln: { lat: 50.9375, lng: 6.9603 },
	cologne: { lat: 50.9375, lng: 6.9603 },
	frankfurt: { lat: 50.1109, lng: 8.6821 },
	stuttgart: { lat: 48.7758, lng: 9.1829 },
	düsseldorf: { lat: 51.2277, lng: 6.7735 },
	dortmund: { lat: 51.5136, lng: 7.4653 },
	essen: { lat: 51.4556, lng: 7.0116 },
	leipzig: { lat: 51.3397, lng: 12.3731 },
	bremen: { lat: 53.0793, lng: 8.8017 },
	dresden: { lat: 51.0504, lng: 13.7373 },
	hannover: { lat: 52.3759, lng: 9.732 },
	nürnberg: { lat: 49.4521, lng: 11.0767 },
	nuremberg: { lat: 49.4521, lng: 11.0767 },
};

/**
 * Attempts to extract a location name from status or event description text.
 */
export function extractLocationName(text: string): string | null {
	if (!text) return null;

	// Look for patterns like "in Mainz", "at Frankfurt", "processed in Berlin", "announced in Hamburg", etc.
	const regex =
		/\b(?:in|at|from|to|near)\s+([A-Z][a-zA-Z-äöüÄÖÜß]+(?:-[A-Z][a-zA-Z-äöüÄÖÜß]+)?)\b/;
	const match = text.match(regex);
	if (match?.[1]) {
		// Filter out common non-place words that might match capitalized in mid-sentence
		const word = match[1].toLowerCase();
		const blacklist = [
			"january",
			"february",
			"march",
			"april",
			"june",
			"july",
			"august",
			"september",
			"october",
			"november",
			"december",
			"today",
			"tomorrow",
			"monday",
			"tuesday",
			"wednesday",
			"thursday",
			"friday",
			"saturday",
			"sunday",
			"hermes",
			"dhl",
			"ups",
			"fedex",
			"depot",
			"hub",
			"sorting",
			"delivery",
		];
		if (blacklist.includes(word)) {
			return null;
		}
		return match[1];
	}

	return null;
}

/**
 * Geocodes a place name into latitude/longitude.
 * Uses an offline database first, falling back to a free Nominatim API request.
 */
export async function geocodeLocation(
	locationName: string,
): Promise<{ lat: number; lng: number } | null> {
	const normalized = locationName.toLowerCase().trim();

	// 1. Check local offline geo dictionary
	if (OFFLINE_GEO_DB[normalized]) {
		return OFFLINE_GEO_DB[normalized];
	}

	// 2. Network-based fallback using OpenStreetMap Nominatim
	try {
		const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
		const resp = await fetch(url, {
			headers: {
				"User-Agent": "OpenParcels/1.0.0 (self-hosted parcel tracker)",
			},
		});

		if (resp.ok) {
			const data = await resp.json();
			if (Array.isArray(data) && data.length > 0) {
				const lat = parseFloat(data[0].lat);
				const lng = parseFloat(data[0].lon);
				if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
					// Cache in-memory for the lifetime of the process
					OFFLINE_GEO_DB[normalized] = { lat, lng };
					return { lat, lng };
				}
			}
		}
	} catch (err) {
		console.error(`Nominatim geocoding failed for "${locationName}":`, err);
	}

	return null;
}
