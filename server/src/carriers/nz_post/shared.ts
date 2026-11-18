import type { ParcelSnapshot } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export const CARRIER_ID = "nz_post";
export const TRACKING_HOST = "tools.nzpost.co.nz";

/** Narrowing helpers for untrusted JSON. */
export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Local map until the shared rules carry an NZ Post table. Keyed by the display text every event
 * carries; wording whose meaning is unclear is left out on purpose so it reports as unknown.
 */
const TEXT_MAP: Readonly<Record<string, ParcelStatus>> = {
  "Tracking number allocated to parcel": "registered",
  "Shipment data submitted": "registered",
  "Label created": "registered",
  "Parcel pickup request received": "registered",
  "Parcel pickup request allocated to driver": "registered",
  "Collected from sender": "in_transit",
  "Picked up/Collected": "in_transit",
  "Handover to airline": "in_transit",
  "International departure": "in_transit",
  "Flight arrival": "in_transit",
  "International arrival": "in_transit",
  "Handover for arrival processing": "in_transit",
  "With border agency": "in_transit",
  "Held for clearance": "in_transit",
  "Released for delivery": "in_transit",
  "Cleared for import": "in_transit",
  "Arrival at sort depot": "in_transit",
  "Arrival at sorting centre": "in_transit",
  // On its way to a collection point, not collectable yet.
  "Handed over": "in_transit",
  "Processing at international depot": "in_transit",
  "Processed at depot": "in_transit",
  "Processed at outbound depot": "in_transit",
  "Processed at facility": "in_transit",
  "At local/regional depot": "in_transit",
  "In transit with airline": "in_transit",
  "In transit to local depot": "in_transit",
  "Ready for courier": "in_transit",
  "With courier for delivery": "out_for_delivery",
  Delayed: "problem",
  "Delivery attempted - refer to card": "problem",
  Delivered: "delivered",
};

/** Fallback for events without display text: the numeric event code. */
const CODES_BY_STATUS: readonly (readonly [ParcelStatus, string])[] = [
  ["registered", "997 205 206 5303 6908"],
  [
    "in_transit",
    "13 144 5000 8 58 591 595 6028 5007 6025 5015 5016 5019 5023 5017 5360 5020 5041 5042 " +
      "5064 5280 5282 5283 5284 5285 5292 6069 6068 6063 6049 6054 6071 5199 5213",
  ],
  ["out_for_delivery", "32 5045"],
  ["problem", "40 52"],
  ["delivered", "22 5022"],
];

const CODE_MAP: ReadonlyMap<string, ParcelStatus> = new Map(
  CODES_BY_STATUS.flatMap(([status, codes]) =>
    codes.split(" ").map((code) => [code, status] as const),
  ),
);

export function mapStatus(key: string | null): ParcelStatus | null {
  if (key === null) {
    return null;
  }
  return TEXT_MAP[key] ?? CODE_MAP.get(key) ?? null;
}

export function publicUrl(barcode: string): string {
  return `https://www.nzpost.co.nz/tools/tracking?trackid=${encodeURIComponent(barcode)}`;
}
