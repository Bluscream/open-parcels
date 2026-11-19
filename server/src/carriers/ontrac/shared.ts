import {
  isoTime as kitIsoTime,
  num as kitNum,
  ruleStatus,
  rulesTrackingUrl,
  text as kitText,
  type ParcelStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "ontrac";
export const TRACKING_HOST = "webtrack.ontrac.com";

export { asObject, isObject, type Json } from "../../plugin/api.js";

/** OnTrac's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Only real numbers; numeric strings stay text. */
export const num = (value: unknown): number | null => kitNum(value, { strings: false });

/** ISO 8601 for a timestamp string; null when it does not parse. Naive values count as UTC. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "utc", keepFraction: true });
/**
 * An OnTrac event code from the shared table. NFRP ("delivered" to another carrier) is
 * deliberately absent: neither delivered nor in transit is certain.
 */
export function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl(CARRIER_ID, barcode, "en");
}
