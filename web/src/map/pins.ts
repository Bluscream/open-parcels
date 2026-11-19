import type { Parcel } from "../api/types";
import type { LatLng } from "./mapIcons";

export interface Pin {
  readonly parcel: Parcel;
  readonly point: LatLng;
  readonly courier: boolean;
  readonly at: string | null;
  /** The carrier's last scan, when a live courier position is shown instead. */
  readonly from: LatLng | null;
  /** The place was looked up from a scan's place name: only the town's centre. */
  readonly approximate: boolean;
}

/**
 * Where to put a parcel on the map: the server's `location` (the live courier, else the newest
 * placed scan). While a courier is shown, `from` is that last scan, for the line to the courier.
 */
export function pinFor(parcel: Parcel): Pin | undefined {
  const location = parcel.location;
  if (location === null) return undefined;
  const courier = location.source === "courier";
  const scan = parcel.last_scan;
  return {
    parcel,
    point: [location.latitude, location.longitude],
    courier,
    at: location.at,
    from: courier && scan !== null ? [scan.latitude, scan.longitude] : null,
    approximate: location.precision === "area",
  };
}
