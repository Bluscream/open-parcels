// Location resolution via LOOKUP_URLS (e.g. https://lookup.minopia.de/api/location/{name})
// In-process cache to avoid redundant requests within a server lifetime.
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

/**
 * Attempts to extract a location name from a status or event description string.
 * Returns the first plausible place name found, or null.
 */
export function extractLocationName(text: string): string | null {
	if (!text) return null;

	// Look for patterns like "in Mainz", "at Frankfurt", "processed in Berlin", etc.
	const regex =
		/\b(?:in|at|from|to|near)\s+([A-Z][a-zA-Z-äöüÄÖÜß]+(?:-[A-Z][a-zA-Z-äöüÄÖÜß]+)?)\b/;
	const match = text.match(regex);
	if (match?.[1]) {
		const word = match[1].toLowerCase();
		const blacklist = [
			"january", "february", "march", "april", "june", "july",
			"august", "september", "october", "november", "december",
			"today", "tomorrow",
			"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
			"hermes", "dhl", "ups", "fedex",
			"depot", "hub", "sorting", "delivery",
		];
		if (!blacklist.includes(word)) return match[1];
	}

	return null;
}

/**
 * Geocodes a place name into latitude/longitude via LOOKUP_URL.
 * Results are cached in-memory for the lifetime of the process.
 */
export async function geocodeLocation(
	locationName: string,
): Promise<{ lat: number; lng: number } | null> {
	const raw = process.env.LOOKUP_URLS ?? "";
	if (!raw.trim()) {
		console.warn("[geocoder] LOOKUP_URLS is not set — skipping geocoding.");
		return null;
	}

	const baseUrls = raw.split(",").map((url) => url.trim().replace(/\/+$/, ""));
	const key = locationName.toLowerCase().trim();

	if (geocodeCache.has(key)) {
		return geocodeCache.get(key)!;
	}

	let result: { lat: number; lng: number } | null = null;
	let lastError: any = null;

	for (const baseUrl of baseUrls) {
		const url = `${baseUrl}/api/location/${encodeURIComponent(locationName)}`;
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

			const body = await resp.json();

			if (!body?.success || !body?.response) {
				continue;
			}

			const { latitude, longitude } = body.response as {
				latitude?: number;
				longitude?: number;
			};

			if (
				typeof latitude === "number" &&
				typeof longitude === "number" &&
				!Number.isNaN(latitude) &&
				!Number.isNaN(longitude)
			) {
				result = { lat: latitude, lng: longitude };
				break;
			}
		} catch (err: any) {
			console.warn(`[geocoder] Failed to geocode "${locationName}" from ${baseUrl}:`, err.message || err);
			lastError = err;
		}
	}

	geocodeCache.set(key, result);
	return result;
}
