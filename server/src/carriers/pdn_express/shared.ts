import {
  isoTime,
  ruleStatus,
  text as kitText,
  type Json,
  type ParcelStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "pdn_express";
export const TRACKING_HOST = "pdn.express";

export { asObject, isObject, newestFirst, type Json } from "../../plugin/api.js";

/** PDN's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });
/**
 * An event code from the shared table: null for customer-service notes and unknown codes;
 * unknown codes go to `report`.
 */
export function mapCode(code: string | null, report: (code: string) => void): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  // Customer-service notes map to unknown in the shared table: they never set a status.
  const status = ruleStatus(CARRIER_ID, code, report);
  return status === "unknown" ? null : status;
}

const OFFSET_PATTERN = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/;
const LOCAL_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * `eventTime` is a wall clock without offset; `utcTimezone` ("UTC+2") carries the offset and
 * already settles daylight saving. Null when either part does not parse.
 */
export function eventTime(event: Json): string | null {
  const local = LOCAL_PATTERN.exec(text(event["eventTime"]) ?? "");
  const offset = OFFSET_PATTERN.exec(text(event["utcTimezone"]) ?? "");
  if (local === null || offset === null) {
    return null;
  }
  const hours = (offset[2] ?? "0").padStart(2, "0");
  const minutes = offset[3] ?? "00";
  return isoTime(`${local[1] ?? ""}T${local[2] ?? ""}`, {
    naive: { offset: `${offset[1] ?? "+"}${hours}:${minutes}` },
  });
}

export function publicUrl(barcode: string): string {
  return `https://pdn.express/en/track/${encodeURIComponent(barcode)}`;
}
