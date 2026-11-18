import { isoTime, ruleStatus, type ParcelStatus } from "../../plugin/api.js";

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
 * A tracking step (`SuiviParEtapes` key) as a canonical status, from the shared table; null for
 * a step it does not know. Step 3 spans days of hub sorting, so it is not "out for delivery".
 */
export function stepStatus(step: number): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, `step:${String(step)}`);
}
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;

/**
 * Milliseconds for a carrier timestamp: a value without offset is wall-clock time in `zone`
 * (or UTC when `zone` is null). The fraction has no fixed width. Null when it does not parse.
 */
export function parseTime(value: unknown, zone: string | null): number | null {
  if (typeof value !== "string" || !ISO_PATTERN.test(value)) {
    return null;
  }
  const iso = isoTime(value, {
    naive: zone === null ? "utc" : { zone },
    dateOnly: false,
    keepFraction: true,
  });
  return iso === null ? null : Date.parse(iso);
}

export function isoAt(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
