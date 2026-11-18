/**
 * Small helpers for reading untrusted carrier payloads: JSON narrowing, timestamps and local
 * wall-clock times. Plug-ins use them instead of each carrying their own copy.
 */
import { TransientError, UnexpectedResponseError } from "./errors.js";
import type { HttpResponse } from "./http.js";

export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

/** The array's object entries; anything else in it, or a non-array, is dropped. */
export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** A trimmed non-empty string, a number as text, or null. */
export function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO 8601 for an ISO string or an epoch timestamp in the given unit; null when it does not parse. */
export function isoTime(value: unknown, epochUnit: "ms" | "s" = "ms"): string | null {
  if (typeof value === "number") {
    const parsed = new Date(epochUnit === "s" ? value * 1000 : value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Parses a JSON body; a body that is not JSON means the carrier answered something unexpected. */
export function readJson(response: HttpResponse, carrier: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`${carrier} did not answer with JSON.`);
  }
}

/** Any status other than the expected ones is a temporary failure, retried with backoff. */
export function expectStatus(response: HttpResponse, carrier: string, ...ok: number[]): void {
  if (!ok.includes(response.status)) {
    throw new TransientError(`${carrier} answered HTTP ${response.status}.`);
  }
}

const HOUR_MS = 3_600_000;
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

function offsetAt(zone: string, instant: number): string {
  let format = offsetFormats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    offsetFormats.set(zone, format);
  }
  const name = format.formatToParts(instant).find((part) => part.type === "timeZoneName");
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name?.value ?? "");
  return match?.[1] ?? "+00:00";
}

const pad = (value: number): string => String(value).padStart(2, "0");

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * A wall-clock time in an IANA zone as an ISO 8601 instant (UTC). The offset is taken a few hours
 * earlier in UTC, which lands on the same side of a DST switch. Null for an impossible date.
 */
export function zonedIso(zone: string, time: WallTime): string | null {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const probe = new Date(guess);
  if (probe.getUTCMonth() !== time.month - 1 || probe.getUTCDate() !== time.day) {
    return null;
  }
  const local = `${time.year}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  const parsed = new Date(`${local}${offsetAt(zone, guess - 3 * HOUR_MS)}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * An ISO-like timestamp: kept when it has an offset, otherwise read as wall-clock time in `zone`.
 * Null when it does not parse.
 */
export function isoInZone(value: unknown, zone: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmed,
    );
  if (match === null) {
    return null;
  }
  if (match[7] !== undefined) {
    return isoTime(trimmed.replace(" ", "T"));
  }
  return zonedIso(zone, {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  });
}

/** Upper-case, accent-free, whitespace-collapsed form of a status wording, for table lookups. */
export function foldWording(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}
