import {
  isoTime as kitIsoTime,
  ruleStatus,
  text as kitText,
  type ParcelStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "paack";
export const TRACKING_HOST = "paack.co";

export { asObject, newestFirst, type Json } from "../../plugin/api.js";

/** Paack's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Strings as `new Date()` reads them, numbers as epoch milliseconds. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: { zone: "Europe/Madrid" }, epoch: "ms" });
/** A Paack event label from the shared table, which maps too little rather than wrongly. */
export function mapLabel(label: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, label);
}

export function publicUrl(barcode: string, postalCode: string | null): string {
  const base = `https://${TRACKING_HOST}/shipments/tracking/order?tracking_number=${encodeURIComponent(barcode)}`;
  return postalCode === null ? base : `${base}&postal_code=${encodeURIComponent(postalCode)}`;
}
