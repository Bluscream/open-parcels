import {
  isoTime as kitIsoTime,
  ruleStatus,
  text as kitText,
  type ParcelStatus,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "nz_post";
export const TRACKING_HOST = "tools.nzpost.co.nz";

export { isObject, type Json } from "../../plugin/api.js";

/** NZ Post's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Strings as `new Date()` reads them, numbers as epoch milliseconds. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: { zone: "Pacific/Auckland" }, epoch: "ms" });

/**
 * The display text every event carries, or the numeric event code of an event without one,
 * through the shared table. Wording whose meaning is unclear stays unmapped and is reported.
 */
export function mapStatus(key: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, key);
}

export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl(CARRIER_ID, barcode);
}
