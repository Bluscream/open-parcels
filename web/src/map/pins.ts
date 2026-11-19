import type { Parcel } from "../api/types";
import type { LatLng } from "./mapIcons";

export interface Pin {
  readonly parcel: Parcel;
  readonly point: LatLng;
  readonly courier: boolean;
  readonly at: string | null;
  /** The carrier's last scan, when a live courier position is shown instead. */
  readonly from: LatLng | null;
}

const LIVE_STATES = new Set(["en_route", "next_stop"]);

/** The current courier position when a live session runs, else the parcel's last known place. */
export function pinFor(parcel: Parcel): Pin | undefined {
  const live = parcel.live;
  const location = parcel.location;
  const scanned: LatLng | null = location === null ? null : [location.latitude, location.longitude];
  if (
    live !== null &&
    LIVE_STATES.has(live.state) &&
    live.latitude !== null &&
    live.longitude !== null
  ) {
    return {
      parcel,
      point: [live.latitude, live.longitude],
      courier: true,
      at: live.position_at,
      from: scanned,
    };
  }
  return location === null || scanned === null
    ? undefined
    : {
        parcel,
        point: scanned,
        courier: location.source === "courier",
        at: location.at,
        from: null,
      };
}
