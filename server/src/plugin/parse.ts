import type { ParcelStatus } from "../domain/parcel.js";
import { UnexpectedResponseError } from "./errors.js";
import type { HttpResponse } from "./http.js";
import type { ParcelSnapshot, SnapshotEvent } from "./snapshot.js";

/**
 * Small helpers most carrier plug-ins need: narrowing untrusted JSON, reading a JSON body or
 * failing fast, turning carrier timestamps into ISO 8601 UTC, and looking codes up one by one.
 */

export type { ParcelStatus } from "../domain/parcel.js";

/** A carrier's own status vocabulary mapped onto the canonical list. */
export type StatusTable = Readonly<Record<string, ParcelStatus>>;

export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Trimmed text for strings and finite numbers; null for anything empty or of another type. */
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

/** Parses a JSON body; a body that is not JSON is an unexpected response, never a guess. */
export function readJson(response: HttpResponse, carrier: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`${carrier} did not answer with JSON.`);
  }
}

/** Like `readJson`, but the body must be an object. */
export function readJsonObject(response: HttpResponse, carrier: string): Json {
  const payload = readJson(response, carrier);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`${carrier} did not answer with a JSON object.`);
  }
  return payload;
}

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `epochMs`. */
function offsetMs(epochMs: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  const asUtc = Date.UTC(
    fields["year"] ?? 0,
    (fields["month"] ?? 1) - 1,
    fields["day"] ?? 1,
    fields["hour"] ?? 0,
    fields["minute"] ?? 0,
    fields["second"] ?? 0,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The instant a wall clock in `timeZone` shows the given local time, as ISO 8601 UTC. */
export function wallClockToIso(local: WallClock, timeZone: string): string | null {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  const check = new Date(guess);
  if (Number.isNaN(guess) || check.getUTCDate() !== local.day) {
    return null;
  }
  const first = guess - offsetMs(guess, timeZone);
  return new Date(guess - offsetMs(first, timeZone)).toISOString();
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Normalises a carrier timestamp to ISO 8601 UTC. Values with an offset are taken as they are;
 * values without one are wall-clock time in `localZone`, or rejected when no zone is known, so a
 * local time is never passed off as UTC.
 */
export function isoTime(value: unknown, localZone: string | null): string | null {
  const raw = text(value);
  if (raw === null || typeof value === "number") {
    return null;
  }
  if (HAS_OFFSET.test(raw)) {
    const at = Date.parse(raw);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const match = LOCAL_ISO.exec(raw);
  if (match === null || localZone === null) {
    return null;
  }
  const n = (index: number): number => Number(match[index] ?? "0");
  return wallClockToIso(
    { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) },
    localZone,
  );
}

/** ISO 8601 UTC for epoch seconds or milliseconds inside a plausible range (2015–2100). */
export function epochToIso(value: unknown, unit: "s" | "ms"): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const ms = unit === "s" ? value * 1000 : value;
  if (ms < Date.UTC(2015, 0, 1) || ms > Date.UTC(2100, 0, 1)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/** History newest first, the order the reconciler expects. */
export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The last second of the local day `iso` falls on: a date alone means "some time that day". */
export function endOfLocalDay(iso: string, timeZone: string): string | null {
  const at = Date.parse(iso);
  const local = new Date(at + offsetMs(at, timeZone));
  return wallClockToIso(
    {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: 23,
      minute: 59,
      second: 59,
    },
    timeZone,
  );
}

/**
 * Looks codes up one at a time. The host limiter paces the requests, an error stops the run
 * before more go out, and codes that cannot be the carrier's are never sent. A null lookup
 * means "not found" and leaves the code out of the result.
 */
export async function trackEach(
  barcodes: readonly string[],
  plausible: RegExp,
  lookUp: (barcode: string) => Promise<ParcelSnapshot | null>,
): Promise<{ snapshots: ParcelSnapshot[]; complete: true }> {
  const snapshots: ParcelSnapshot[] = [];
  for (const barcode of barcodes) {
    if (!plausible.test(barcode)) {
      continue;
    }
    const found = await lookUp(barcode);
    if (found !== null) {
      snapshots.push(found);
    }
  }
  return { snapshots, complete: true };
}
