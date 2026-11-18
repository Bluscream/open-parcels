import type { ParcelStatus } from "../../domain/parcel.js";

export const CARRIER_ID = "nova_post";
export const TRACKING_HOST = "api.novaposhta.ua";
export const HISTORY_LIMIT = 20;

export function publicUrl(barcode: string): string {
  return `https://novaposhta.ua/tracking/${encodeURIComponent(barcode)}`;
}

/**
 * `tracking[].code` to canonical statuses, after the carrier's published status table. Local until
 * the shared rules package has a table for this carrier. The carrier's own "Delivered" wording
 * (7, 8) means arrived at the branch or locker; "Received" (9, 10, 11, 106) is the hand-over.
 */
export const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  "1": "registered",
  "2": "problem",
  "4": "in_transit",
  "5": "in_transit",
  "6": "in_transit",
  "7": "at_pickup_point",
  "8": "at_pickup_point",
  "9": "delivered",
  "10": "delivered",
  "11": "delivered",
  "13": "in_transit",
  "16": "in_transit",
  "17": "in_transit",
  "19": "in_transit",
  "30": "in_transit",
  "31": "in_transit",
  "99": "problem",
  "101": "out_for_delivery",
  "102": "returning",
  "103": "returning",
  "104": "in_transit",
  "105": "problem",
  "106": "delivered",
  "110": "in_transit",
  "111": "problem",
  "112": "in_transit",
  "113": "problem",
  "114": "in_transit",
  "115": "in_transit",
  "116": "problem",
  "117": "problem",
  "118": "problem",
  "119": "in_transit",
  "120": "in_transit",
  "121": "in_transit",
  "122": "in_transit",
  "123": "problem",
  "125": "in_transit",
  "126": "in_transit",
  "127": "in_transit",
  "128": "in_transit",
  "130": "problem",
  "131": "returning",
  "132": "returning",
  "133": "problem",
  "134": "in_transit",
  "135": "in_transit",
  "138": "problem",
  "141": "problem",
  "144": "problem",
  "149": "in_transit",
  "155": "problem",
  "197": "in_transit",
  "198": "in_transit",
  "199": "in_transit",
  "999": "unknown",
};

/** The carrier's own catch-all: known, but deliberately left unmapped. */
export const UNDETERMINED_CODE = "999";
export const RECEIVED_CODES: ReadonlySet<string> = new Set(["9", "10", "11", "106"]);

export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/;

/** ISO 8601 for a carrier timestamp; a value without offset is read as UTC. Null when unparseable. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return null;
  }
  const normalised = value.trim().replace(" ", "T");
  const withZone = OFFSET_PATTERN.test(normalised)
    ? normalised
    : normalised.length === 10
      ? `${normalised}T00:00:00Z`
      : `${normalised}Z`;
  const parsed = Date.parse(withZone);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
