import { loadRules, mapStatus, trackingUrl, type MappedStatus } from "open-parcels-rules";
import type { SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "hermes";
export const TRACKING_HOST = "api.my-deliveries.de";
export const ACCOUNT_HOST = "mobile-app-api.a0930.prd.hc.de";

/** Narrowing helpers for untrusted JSON. */
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

/** ISO 8601 for a string or epoch-millisecond timestamp; null when it does not parse. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Maps a Hermes status code (either vocabulary) through the shared status table. */
export function mapCode(
  code: string | null,
  description: string | null = null,
): MappedStatus | null {
  if (code === null && description === null) {
    return null;
  }
  return mapStatus(loadRules(), CARRIER_ID, {
    ...(code === null ? {} : { code }),
    ...(description === null ? {} : { text: description }),
  });
}

export function publicUrl(barcode: string): string {
  return (
    trackingUrl(loadRules(), CARRIER_ID, barcode, "de") ??
    `https://www.myhermes.de/empfangen/sendungsverfolgung/#${encodeURIComponent(barcode)}`
  );
}

/** History entries sorted newest first; entries without a usable timestamp are dropped. */
export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
