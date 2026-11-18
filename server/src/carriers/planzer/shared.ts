import type { SnapshotEvent } from "../../plugin/api.js";

type ParcelStatus = NonNullable<SnapshotEvent["status"]>;

export const CARRIER_ID = "planzer";
export const TRACKING_HOST = "api.tracking.app.planzer.ch";
const CARRIER_TIME_ZONE = "Europe/Zurich";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Picks one language from a four-language text object, falling back to German. */
export function localized(value: unknown, language: "english" | "german"): string | null {
  const object = asObject(value);
  return text(object[language]) ?? text(object["german"]);
}

/**
 * Planzer has no status codes, so the German text is the key: the English one renders
 * "Zugestellt" as "Shipped", which would file a delivered parcel as dispatched. Only observed
 * texts are listed. Not in the shared rules package yet, so kept here.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  "sendung zugestellt": "delivered",
  erfasst: "registered",
  übergeben: "in_transit",
  "in zustellung": "out_for_delivery",
  zugestellt: "delivered",
};

function textKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The mapped status, or null; unmapped texts go to `report`. */
export function mapText(german: string | null, report: (key: string) => void): ParcelStatus | null {
  if (german === null) {
    return null;
  }
  const key = textKey(german);
  const mapped = STATUS_MAP[key];
  if (mapped === undefined) {
    report(key);
    return null;
  }
  return mapped;
}

const zoneFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CARRIER_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of Zurich from UTC, in milliseconds, at the given instant. */
function zoneOffsetMs(at: number): number {
  const parts = Object.fromEntries(
    zoneFormat.formatToParts(new Date(at)).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Reads a wall-clock time without offset as Zurich time; null when it does not parse. */
export function zurichTime(local: string): string | null {
  const naive = Date.parse(`${local}Z`);
  if (Number.isNaN(naive)) {
    return null;
  }
  // Two passes settle the offset around a daylight-saving switch.
  let at = naive - zoneOffsetMs(naive);
  at = naive - zoneOffsetMs(at);
  return new Date(at).toISOString();
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
