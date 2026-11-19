import type { Parcel } from "../api/types";
import { distanceKm, type LatLngTuple } from "../lib/geo";

const LIVE_STATES = new Set(["en_route", "next_stop"]);

/** Where the parcel is now: the live courier, else its latest scan with a position. */
export function currentPoint(parcel: Parcel): LatLngTuple | null {
  const live = parcel.live;
  if (
    live !== null &&
    LIVE_STATES.has(live.state) &&
    live.latitude !== null &&
    live.longitude !== null
  ) {
    return [live.latitude, live.longitude];
  }
  const location = parcel.location;
  return location === null ? null : [location.latitude, location.longitude];
}

/** Kilometres still to go to the home location, or null (delivered, no home, no position). */
export function kmToHome(parcel: Parcel, home: LatLngTuple | null): number | null {
  if (parcel.delivered || home === null) return null;
  const point = currentPoint(parcel);
  return point === null ? null : distanceKm(point, home);
}
