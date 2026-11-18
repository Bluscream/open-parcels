/**
 * Canonical event types. The parcel ones follow the Home Assistant suite's contract: the hop to
 * `delivered` fires only `parcel.delivered`, never also `parcel.status_changed`.
 */
export const EVENT_TYPES = [
  "parcel.registered",
  "parcel.status_changed",
  "parcel.delivered",
  "parcel.delivery_time_changed",
  "parcel.outgoing_registered",
  "parcel.outgoing_delivered",
  "parcel.live_updated",
  "parcel.removed",
  "source.state_changed",
  "vocab.unknown",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface OutboxEvent {
  readonly seq: number;
  readonly type: EventType;
  readonly parcelId: string | null;
  readonly payload: unknown;
  readonly createdAt: string;
}
