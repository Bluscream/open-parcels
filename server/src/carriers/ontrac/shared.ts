import { loadRules, trackingUrl } from "open-parcels-rules";
import type { SnapshotEvent } from "../../plugin/api.js";

type ParcelStatus = NonNullable<SnapshotEvent["status"]>;

export const CARRIER_ID = "ontrac";
export const TRACKING_HOST = "webtrack.ontrac.com";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
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

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** ISO 8601 for a timestamp string; null when it does not parse. Naive values count as UTC. */
export function isoTime(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(zoned);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * OnTrac event codes. Kept local until the shared rules carry an OnTrac table. NFRP ("delivered"
 * to another carrier) is deliberately absent: neither delivered nor in transit is certain.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  EXRL: "registered",
  INRL: "registered",
  ORIG: "in_transit",
  ARRD: "in_transit",
  SFCT: "in_transit",
  FCTF: "in_transit",
  LOAD: "in_transit",
  OFDL: "out_for_delivery",
  DLVD: "delivered",
  BCLD: "problem",
  NDMI: "problem",
  UTLV: "problem",
  ONHD: "problem",
};

export function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS_MAP[code] ?? null);
}

export function publicUrl(barcode: string): string {
  return (
    trackingUrl(loadRules(), CARRIER_ID, barcode, "en") ??
    `https://www.ontrac.com/tracking/?number=${encodeURIComponent(barcode)}`
  );
}
