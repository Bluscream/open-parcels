/**
 * Small helpers for reading untrusted carrier payloads. Every carrier needs the same narrowing
 * and the same "local time without an offset" conversion, so they live here once.
 */
import { UnexpectedResponseError } from "./errors.js";
import type { HttpResponse } from "./http.js";
import type { SnapshotEvent } from "./snapshot.js";

export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The objects in a list; anything else in it is skipped. */
export function objects(value: unknown): Json[] {
  return asList(value).filter(isObject);
}

/** A trimmed non-empty string, or null. */
export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A finite number (numeric strings included), or null. Booleans are not numbers. */
export function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A positive weight in kilograms, or null. */
export function positive(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** The body as JSON, or an UnexpectedResponseError naming the carrier. */
export function readJson(response: HttpResponse, carrier: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`${carrier} did not answer with JSON.`);
  }
}

/** Like readJson, but the answer must be an object. */
export function readObject(response: HttpResponse, carrier: string): Json {
  const payload = readJson(response, carrier);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`${carrier} did not answer with an object.`);
  }
  return payload;
}

const HOUR_MS = 3_600_000;
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function offsetIn(zone: string, instant: number): string {
  let format = offsetFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    offsetFormats.set(zone, format);
  }
  const name = format.formatToParts(instant).find((part) => part.type === "timeZoneName");
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name?.value ?? "");
  return match?.[1] ?? "+00:00";
}

const LOCAL_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * An ISO-like timestamp as ISO 8601 with offset. Values that carry their own offset keep it;
 * values without one are wall-clock time in `zone`. The zone's offset is read a few hours
 * earlier in UTC, which lands on the right side of a DST switch. Null when it does not parse.
 */
export function zonedIso(value: unknown, zone: string): string | null {
  const raw = text(value);
  const match = raw === null ? null : LOCAL_TIME.exec(raw);
  if (raw === null || match === null) {
    return null;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", offset] = match;
  const parts = [y, mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [year, month, day, hour, minute, second] = parts;
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  if (offset !== undefined) {
    const parsed = new Date(raw.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const local = `${y ?? ""}-${mo ?? ""}-${d ?? ""}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return `${local}${offsetIn(zone, probe.getTime() - 3 * HOUR_MS)}`;
}

/**
 * Epoch milliseconds or an ISO string as ISO 8601; null when it does not parse. A string
 * without an offset is read as UTC, never as the server's own zone.
 */
export function instantIso(value: unknown): string | null {
  if (typeof value === "string") {
    const zoned = zonedIso(value, "UTC");
    return zoned === null ? null : new Date(zoned).toISOString();
  }
  if (typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** History entries newest first, the order snapshots carry them in. */
export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Lower-cased, whitespace-collapsed text for matching carrier wording. */
export function fold(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
