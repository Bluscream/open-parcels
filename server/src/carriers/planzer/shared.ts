import {
  asObject,
  isoTime,
  ruleStatus,
  text as kitText,
  type ParcelStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "planzer";
export const TRACKING_HOST = "api.tracking.app.planzer.ch";
const CARRIER_TIME_ZONE = "Europe/Zurich";

export { asObject, isObject, type Json } from "../../plugin/api.js";

/** Planzer's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });
/** Picks one language from a four-language text object, falling back to German. */
export function localized(value: unknown, language: "english" | "german"): string | null {
  const object = asObject(value);
  return text(object[language]) ?? text(object["german"]);
}

/**
 * Planzer has no status codes, so the German text is the shared table's key: the English one
 * renders "Zugestellt" as "Shipped", which would file a delivered parcel as dispatched.
 */
function textKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The mapped status, or null; unmapped texts go to `report`. */
export function mapText(german: string | null, report: (key: string) => void): ParcelStatus | null {
  if (german === null) {
    return null;
  }
  return ruleStatus(CARRIER_ID, textKey(german), report);
}

/** Reads a wall-clock time without offset as Zurich time, keeping milliseconds; null otherwise. */
export function zurichTime(local: string): string | null {
  return isoTime(local, { naive: { zone: CARRIER_TIME_ZONE }, keepFraction: true });
}
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * `createdAt` mixes 7- and 3-digit fractions and usually carries no offset; without one it is
 * read as Zurich time, the carrier's only market.
 */
export function carrierTime(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.replace(/(\.\d{3})\d+/, "$1");
  if (OFFSET_SUFFIX.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return zurichTime(trimmed);
}

export function publicUrl(barcode: string): string {
  return `https://tracking.app.planzer.ch/?deliveryNumber=${encodeURIComponent(barcode)}&system=Pak`;
}
