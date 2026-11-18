import type { ParcelSnapshot, SnapshotEvent } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export const CARRIER_ID = "paack";
export const TRACKING_HOST = "paack.co";

/** Narrowing helpers for untrusted JSON. */
export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO 8601 for a string or epoch-millisecond timestamp; null when it does not parse. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Paack's event labels. Local until open-parcels-rules has a table for this carrier; prefer
 * mapping too little over mapping wrongly.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  manifested: "registered",
  created: "registered",
  appointmentChangedToNextAvailableDay: "registered",
  scannedAtOrigin: "in_transit",
  receivedAtHub: "in_transit",
  sorted: "in_transit",
  warehouse: "in_transit",
  inDelivery: "out_for_delivery",
  driverAssigned: "out_for_delivery",
  inProgress: "out_for_delivery",
  readyForPickup: "at_pickup_point",
  atPickupPoint: "at_pickup_point",
  droppedInPudo: "at_pickup_point",
  delivered: "delivered",
  collectedByCustomer: "delivered",
  returnedToSender: "returning",
  returnedToRetailer: "returning",
  logisticIssueOpen: "problem",
  incorrectAddress: "problem",
  damaged: "problem",
  lost: "problem",
};

export function mapLabel(label: string | null): ParcelStatus | null {
  return label === null ? null : (STATUS_MAP[label] ?? null);
}

export function publicUrl(barcode: string, postalCode: string | null): string {
  const base = `https://${TRACKING_HOST}/shipments/tracking/order?tracking_number=${encodeURIComponent(barcode)}`;
  return postalCode === null ? base : `${base}&postal_code=${encodeURIComponent(postalCode)}`;
}

export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
