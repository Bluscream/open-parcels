import type { ParcelStatus } from "../../domain/parcel.js";

export const CARRIER_ID = "mondial_relay";
/** The .be and .nl sites answer the same lookup; the .fr site refuses scripted clients. */
export const TRACKING_HOST = "www.mondialrelay.be";
export const PAGE_URL = `https://${TRACKING_HOST}/nl-be/shipment-tracking`;
export const API_URL = `https://${TRACKING_HOST}/api/tracking`;
/** Timestamps arrive as naive local time in this zone. */
export const CARRIER_TZ = "Europe/Paris";
/** Delivery to a relay point, the only mode where step 4 means "ready to collect". */
export const PICKUP_POINT_MODE = "24R";
export const STEP_AVAILABLE = 4;
export const STEP_DELIVERED = 5;
export const HISTORY_LIMIT = 20;

/**
 * Tracking steps (`SuiviParEtapes` keys) to canonical statuses. Local until the shared rules
 * package has a table for this carrier. Step 3 spans days of hub sorting, so it is not "out for
 * delivery".
 */
export const STEP_MAP: Readonly<Record<number, ParcelStatus>> = {
  1: "registered",
  2: "in_transit",
  3: "in_transit",
  4: "at_pickup_point",
  5: "delivered",
};

export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Offset of `zone` from UTC at the instant `utcMs`, in milliseconds. */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `zone`, given as milliseconds of the naive value read as UTC. */
export function zonedToUtc(naiveMs: number, zone: string): number {
  const first = naiveMs - zoneOffsetMs(naiveMs, zone);
  return naiveMs - zoneOffsetMs(first, zone);
}

/** The calendar day an instant falls on in `zone`, as UTC-midnight milliseconds of that day. */
export function localDay(utcMs: number, zone: string): number {
  const local = utcMs + zoneOffsetMs(utcMs, zone);
  return local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
}

const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;

/**
 * Milliseconds for a carrier timestamp: a value without offset is wall-clock time in `zone`
 * (or UTC when `zone` is null). The fraction has no fixed width. Null when it does not parse.
 */
export function parseTime(value: unknown, zone: string | null): number | null {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) {
    return null;
  }
  if (OFFSET_PATTERN.test(value)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const naive = Date.parse(`${value}Z`);
  if (Number.isNaN(naive)) {
    return null;
  }
  return zone === null ? naive : zonedToUtc(naive, zone);
}

export function isoAt(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
