/**
 * Timestamp helpers. Snapshots carry ISO 8601 instants; carriers often send local wall-clock
 * times without an offset, which are read in the carrier's own zone, never passed off as UTC.
 */

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** Epoch values below this are seconds, not milliseconds (it is 2001-09-09 in milliseconds). */
const MILLISECOND_FLOOR = 1e12;

export type WallClock = readonly [number, number, number, number, number, number];

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

function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  const get = (key: string): number => fields[key] ?? 0;
  return [get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second")];
}

function offsetMs(epochMs: number, timeZone: string): number {
  const [year, month, day, hour, minute, second] = wallClockAt(epochMs, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function isRealDay(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** A local wall-clock time in `timeZone` as an ISO instant; null for an impossible date. */
export function zonedIso(parts: WallClock, timeZone: string): string | null {
  const [year, month, day, hour, minute, second] = parts;
  if (!isRealDay(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - offsetMs(guess, timeZone);
  return new Date(guess - offsetMs(first, timeZone)).toISOString();
}

/** An epoch timestamp (milliseconds, or seconds when small) as ISO. */
export function epochIso(value: number): string | null {
  const ms = Math.abs(value) < MILLISECOND_FLOOR ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Normalises a carrier timestamp: epoch numbers, ISO strings with an offset, and offset-less
 * `YYYY-MM-DD[ HH:MM[:SS]]` read in `localZone`. Without a zone a naive value is rejected.
 */
export function isoTime(value: unknown, localZone: string | null): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? epochIso(value) : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{10,13}$/.test(trimmed)) {
    return epochIso(Number(trimmed));
  }
  if (HAS_OFFSET.test(trimmed)) {
    const at = Date.parse(trimmed);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const match = NAIVE.exec(trimmed);
  if (match === null || localZone === null) {
    return null;
  }
  const n = (index: number): number => Number(match[index] ?? "0");
  return zonedIso([n(1), n(2), n(3), n(4), n(5), n(6)], localZone);
}

/** The first and last second of the local day an instant falls on. */
export function localDay(iso: string, timeZone: string): { from: string; to: string } | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const [year, month, day] = wallClockAt(at, timeZone);
  const from = zonedIso([year, month, day, 0, 0, 0], timeZone);
  const to = zonedIso([year, month, day, 23, 59, 59], timeZone);
  return from === null || to === null ? null : { from, to };
}

/** Sort key; unparseable values sort last when sorting newest first. */
export function epoch(iso: string | null): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** Sorts entries with an `at` timestamp newest first, the order snapshots carry history in. */
export function newestFirst<T extends { readonly at: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => epoch(b.at) - epoch(a.at));
}
