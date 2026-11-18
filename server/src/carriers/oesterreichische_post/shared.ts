import type { ParcelSnapshot } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export const CARRIER_ID = "oesterreichische_post";
export const TRACKING_HOST = "api.post.at";

/** Narrowing helpers for untrusted JSON. */
export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const VIENNA = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Vienna",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** Offset of Vienna from UTC, in milliseconds, at the given instant. */
function viennaOffset(at: number): number {
  const parts = Object.fromEntries(
    VIENNA.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return wall - (at - (at % 1000));
}

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/**
 * ISO 8601 for a carrier timestamp. Austrian Post stamps in local time and sometimes leaves the
 * offset off; such values are read as Vienna time, never as UTC. Numbers are epoch milliseconds.
 */
export function isoTime(value: unknown): string | null {
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  if (HAS_ZONE.test(raw) || !LOCAL_TIME.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const asUtc = Date.parse(`${raw.replace(" ", "T")}${raw.length === 10 ? "T00:00:00" : ""}Z`);
  if (Number.isNaN(asUtc)) {
    return null;
  }
  // Two passes settle the offset around a daylight-saving switch.
  const first = asUtc - viennaOffset(asUtc);
  return new Date(asUtc - viennaOffset(first)).toISOString();
}

/** The state keys arrive in camelCase; the vocabulary is written in UPPER_SNAKE. */
export function normalizeKey(key: unknown): string | null {
  const raw = text(key);
  return raw === null ? null : raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Local map until the shared rules carry an Austrian Post table: the carrier's complete tracking
 * state vocabulary. `DELIVERY_INTERUPTED` is the carrier's own spelling. `UNKNOWN` is left out on
 * purpose: seeing it means the vocabulary moved, so it should be reported.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  PENDING_INFORMATION: "registered",
  PARCEL_STAMP: "registered",
  AVISO: "registered",
  ALLES_POST: "registered",
  DELIVERY_HAND_OVER: "in_transit",
  IN_DISTRIBUTION: "in_transit",
  CUSTOMS_CLEARANCE: "in_transit",
  DELIVERY_IN_CUSTOMS: "in_transit",
  IN_DELIVERY: "out_for_delivery",
  NOTIFIED: "at_pickup_point",
  READY_FOR_PICK_UP: "at_pickup_point",
  READY_FOR_PICK_UP_STATION: "at_pickup_point",
  READY_FOR_PICK_UP_POINT: "at_pickup_point",
  READY_FOR_PICK_UP_BOX: "at_pickup_point",
  DELIVERED: "delivered",
  // Left at the agreed safe place; the carrier itself counts it as delivered.
  DELIVERY_PARKED: "delivered",
  DELIVERY_IN_RETURN: "returning",
  DELIVERY_DELAYED: "problem",
  DELIVERY_INTERUPTED: "problem",
  NOT_REACHABLE: "problem",
};

export function mapStatus(key: string | null): ParcelStatus | null {
  return key === null ? null : (STATUS_MAP[key] ?? null);
}

export function publicUrl(barcode: string): string {
  return `https://www.post.at/s/sendungsdetails?snr=${encodeURIComponent(barcode)}`;
}
