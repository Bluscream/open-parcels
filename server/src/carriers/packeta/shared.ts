import type { ParcelSnapshot } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export const CARRIER_ID = "packeta";
/** One host serves both brands (Packeta and Zásilkovna). */
export const TRACKING_HOST = "tracking.packeta.com";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

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

const NAIVE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const PRAGUE = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Prague",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of Prague from UTC, in milliseconds, at the given instant. */
function pragueOffset(utcMs: number): number {
  const parts = Object.fromEntries(PRAGUE.formatToParts(utcMs).map((p) => [p.type, p.value]));
  const local = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return local - utcMs;
}

/**
 * Event times come without an offset ("2026-01-01 12:00:00"). Packeta is a Czech carrier, so
 * a naive time is read as Prague local time; a time with an offset is taken as it is.
 */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = NAIVE_TIME.exec(value.trim());
  if (match === null) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  // Two passes settle the offset correctly across a daylight-saving change.
  const first = asUtc - pragueOffset(asUtc);
  return new Date(asUtc - pragueOffset(first)).toISOString();
}

export function publicUrl(barcode: string): string {
  return `https://${TRACKING_HOST}/en/?id=${encodeURIComponent(barcode)}`;
}
