/** Small geography helpers for the maps and distances. */

export type LatLngTuple = [number, number];

/**
 * "52.52, 13.405", "52.52 13.405", "52.52;13.405" or "52,52 13,405" (decimal commas) as a point,
 * or null when the text is not a pair of valid coordinates.
 */
export function parseLatLng(text: string): LatLngTuple | null {
  const trimmed = text.trim();
  // Two numbers, each with a "." or a "," as decimal mark, separated by ",", ";" or spaces.
  const match =
    /^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/u.exec(trimmed) ??
    /^(-?\d{1,3}(?:,\d+)?)\s*[;\s]\s*(-?\d{1,3}(?:,\d+)?)$/u.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const latitude = Number(match[1].replace(",", "."));
  const longitude = Number(match[2].replace(",", "."));
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return [latitude, longitude];
}

const EARTH_RADIUS_KM = 6371.0088;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function distanceKm(from: LatLngTuple, to: LatLngTuple): number {
  const dLat = rad(to[0] - from[0]);
  const dLng = rad(to[1] - from[1]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from[0])) * Math.cos(rad(to[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "350 m", "4.2 km", "106 km", "1,234 km" in the browser's number format. */
export function formatDistance(km: number, locale?: string): string {
  if (km < 1) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(km * 100) * 10)} m`;
  }
  const digits = km < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(km)} km`;
}

/** Coordinates as typed back into the box: six decimals is about 10 cm. */
export function formatLatLng([latitude, longitude]: LatLngTuple): string {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}
