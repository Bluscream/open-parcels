import type { Parcel } from "../domain/parcel.js";

/**
 * Event payloads carry the parcel without courier coordinates: events are stored, replayed and
 * forwarded (to Home Assistant's recorder, for example), and positions must never be persisted.
 */
export function parcelForEvent(parcel: Parcel): Parcel {
  return {
    ...parcel,
    live:
      parcel.live === null
        ? null
        : { ...parcel.live, latitude: null, longitude: null, accuracy: null },
    // While a courier is shown, `location` is the courier: stored events keep the last scan.
    location: parcel.location?.source === "courier" ? parcel.last_scan : parcel.location,
  };
}

export function parcelEventPayload(
  parcel: Parcel,
  changes: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { parcel: parcelForEvent(parcel), ...changes };
}
