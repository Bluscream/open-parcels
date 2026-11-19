import {
  isoTime as kitIsoTime,
  ruleStatus,
  rulesStatus,
  text as kitText,
  type ParcelStatus,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "packeta";
/** One host serves both brands (Packeta and Zásilkovna). */
export const TRACKING_HOST = "tracking.packeta.com";

export { asObject, type Json } from "../../plugin/api.js";

/** Packeta's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

export function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

/**
 * History entries carry only an English sentence (the locale is pinned to `en`); the sentences
 * are fixed templates, so the shared table's fragment match is safe.
 */
export function mapEventText(sentence: string): ParcelStatus | null {
  const lowered = sentence.toLowerCase();
  return rulesStatus(CARRIER_ID, { text: lowered })?.status ?? null;
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
    : kitIsoTime(value, { naive: { zone: "Europe/Prague" } });
}
export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl(CARRIER_ID, barcode);
}
