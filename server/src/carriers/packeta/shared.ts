import { isoTime as kitIsoTime, text as kitText, type ParcelStatus } from "../../plugin/api.js";

export const CARRIER_ID = "packeta";
/** One host serves both brands (Packeta and Zásilkovna). */
export const TRACKING_HOST = "tracking.packeta.com";

export { asObject, type Json } from "../../plugin/api.js";

/** Packeta's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });
/** Packeta's numeric `packetStatusId`. Local until open-parcels-rules has a table. */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  "997": "registered",
  "1": "in_transit",
  "31": "in_transit",
  "2": "at_pickup_point",
  "3": "delivered",
  "21": "problem",
};

export function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS_MAP[code] ?? null);
}

/**
 * History entries carry only an English sentence (the locale is pinned to `en`); the sentences
 * are fixed templates, so a substring match is safe.
 */
const EVENT_TEXTS: readonly (readonly [string, ParcelStatus])[] = [
  ["aware of your parcel and are waiting for the sender", "registered"],
  ["assigned a tracking number", "registered"],
  ["successfully received the parcel for transport", "in_transit"],
  ["on its way to the depot", "in_transit"],
  ["arrived at the depot", "in_transit"],
  ["has been handed over to the carrier", "in_transit"],
  ["on its way to you", "out_for_delivery"],
  ["ready for pickup", "at_pickup_point"],
  ["the parcel is with you", "delivered"],
  ["investigating the status of the parcel", "problem"],
];

export function mapEventText(sentence: string): ParcelStatus | null {
  const lowered = sentence.toLowerCase();
  return EVENT_TEXTS.find(([needle]) => lowered.includes(needle))?.[1] ?? null;
}

const NAIVE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Event times come without an offset ("2026-01-01 12:00:00"). Packeta is a Czech carrier, so
 * a naive time is read as Prague local time; anything else is read as `new Date()` reads it.
 */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return NAIVE_TIME.test(value.trim())
    ? kitIsoTime(value, { naive: { zone: "Europe/Prague" }, keepFraction: true })
    : kitIsoTime(value, { naive: "runtime" });
}
export function publicUrl(barcode: string): string {
  return `https://${TRACKING_HOST}/en/?id=${encodeURIComponent(barcode)}`;
}
