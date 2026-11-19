import type { Parcel } from "../api/types";
import { distanceKm, type LatLngTuple } from "../lib/geo";

/**
 * Kilometres still to go to the home location, from where the server says the parcel is now
 * (`location`: the live courier, else its newest placed scan). Null when delivered, without a
 * home or without a place.
 */
export function kmToHome(parcel: Parcel, home: LatLngTuple | null): number | null {
  const location = parcel.location;
  if (parcel.delivered || home === null || location === null) return null;
  return distanceKm([location.latitude, location.longitude], home);
}
