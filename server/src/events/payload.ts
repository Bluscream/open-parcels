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
  };
}

export function parcelEventPayload(
  parcel: Parcel,
  changes: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { parcel: parcelForEvent(parcel), ...changes };
}
