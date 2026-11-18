/**
 * Timestamp helpers. Snapshots carry ISO 8601 instants. Carriers often send local wall-clock times
 * without an offset; how such a value is read is a per-carrier decision passed in explicitly as
 * `naive`, never a hidden default.
 */
import { text } from "./json.js";

/** A local wall-clock time. Missing time fields are 0. */
export interface WallTime {
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

/** The wall clock in `timeZone` at an instant. */
export function wallTimeAt(epochMs: number, timeZone: string): Required<WallTime> {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  const get = (key: string): number => fields[key] ?? 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(epochMs: number, timeZone: string): number {
  const wall = wallTimeAt(epochMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** True for an IANA zone name the runtime knows, for validating zone options in configs. */
export function isTimeZone(value: string): boolean {
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

const pad = (value: number): string => String(value).padStart(2, "0");

function offsetText(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  return `${ms < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function isRealWallTime(time: Required<WallTime>): boolean {
  const probe = new Date(Date.UTC(time.year, time.month - 1, time.day));
  return (
    !Number.isNaN(probe.getTime()) &&
    probe.getUTCFullYear() === time.year &&
    probe.getUTCMonth() === time.month - 1 &&
    probe.getUTCDate() === time.day &&
    time.hour <= 23 &&
    time.minute <= 59 &&
    time.second <= 59
  );
}

export interface ZonedOptions {
  /**
   * Return the local time with the zone's offset (`2026-11-18T14:30:00+01:00`) instead of UTC
   * (`2026-11-18T13:30:00.000Z`). Both name the same instant.
   */
  readonly keepOffset?: boolean;
}

/** A wall-clock time in an IANA zone as an ISO 8601 instant; null for an impossible date or time. */
export function zonedIso(
  time: WallTime,
  timeZone: string,
  options: ZonedOptions = {},
): string | null {
  const full = { hour: 0, minute: 0, second: 0, ...time };
  if (!isRealWallTime(full)) {
    return null;
  }
  const guess = Date.UTC(full.year, full.month - 1, full.day, full.hour, full.minute, full.second);
  const instant = guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone);
  if (options.keepOffset !== true) {
    return new Date(instant).toISOString();
  }
  const local = `${full.year}-${pad(full.month)}-${pad(full.day)}T${pad(full.hour)}:${pad(full.minute)}:${pad(full.second)}`;
  return `${local}${offsetText(guess - instant)}`;
}

/** Epoch values below this are seconds, not milliseconds (it is 2001-09-09 in milliseconds). */
const MILLISECOND_FLOOR = 1e12;

export type EpochUnit = "s" | "ms" | "auto";

export interface EpochOptions {
  /** Reject instants outside 2015–2100, for fields that may also hold small counters. */
  readonly plausible?: boolean;
}

/** An epoch timestamp as ISO 8601 UTC. `auto` reads small values as seconds. */
export function epochIso(
  value: unknown,
  unit: EpochUnit,
  options: EpochOptions = {},
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const seconds = unit === "s" || (unit === "auto" && Math.abs(value) < MILLISECOND_FLOOR);
  const ms = seconds ? value * 1000 : value;
  if (options.plausible === true && (ms < Date.UTC(2015, 0, 1) || ms > Date.UTC(2100, 0, 1))) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * How a timestamp without an offset is read:
 * - `reject`: never guessed, the value gives null;
 * - `utc`: as UTC;
 * - `{ zone }`: as wall-clock time in that IANA zone;
 * - `{ offset }`: with this fixed offset, such as `+01:00`;
 * - `runtime`: whatever `new Date()` makes of the whole string (date-only values as UTC, date-times
 *   in the process zone, other formats as the runtime parses them). Only for carriers whose
 *   behaviour already depended on it; prefer a zone.
 */
export type NaiveTime =
  "reject" | "utc" | "runtime" | { readonly zone: string } | { readonly offset: string };

export interface TimeOptions {
  readonly naive: NaiveTime;
  /** How numbers are read. Default: they are not timestamps. */
  readonly epoch?: EpochUnit | "none";
  /** Read 10–13 digit strings as epoch values (seconds or milliseconds by size). Default false. */
  readonly epochStrings?: boolean;
  /** Accept `YYYY-MM-DD` without a time, as midnight. Default true. */
  readonly dateOnly?: boolean;
  /** For zoned values, keep the local time and offset instead of converting to UTC. */
  readonly keepOffset?: boolean;
  /**
   * Keep the milliseconds of an offset-less value (`10:00:00.250`). Default false: such values
   * are read to the whole second, as most carriers only send whole seconds.
   */
  readonly keepFraction?: boolean;
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

function naiveIso(raw: string, options: TimeOptions): string | null {
  const match = NAIVE.exec(raw);
  const naive = options.naive;
  if (match === null || naive === "reject" || naive === "runtime") {
    return null;
  }
  if (match[4] === undefined && options.dateOnly === false) {
    return null;
  }
  const n = (index: number): number => Number(match[index] ?? "0");
  const time = { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) };
  const fraction = options.keepFraction === true ? (match[7] ?? "") : "";
  if (naive === "utc") {
    return withFraction(zonedIso(time, "UTC"), fraction);
  }
  if ("zone" in naive) {
    const keepOffset = options.keepOffset === true;
    return withFraction(zonedIso(time, naive.zone, { keepOffset }), fraction);
  }
  if (!isRealWallTime(time)) {
    return null;
  }
  const local = `${match[1] ?? ""}-${match[2] ?? ""}-${match[3] ?? ""}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  const parsed = new Date(`${local}${naive.offset}`);
  return Number.isNaN(parsed.getTime()) ? null : withFraction(parsed.toISOString(), fraction);
}

/** Adds the milliseconds of a fraction such as `5` or `123456` to an ISO instant. */
function withFraction(iso: string | null, fraction: string): string | null {
  if (iso === null || fraction === "") {
    return iso;
  }
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
  if (iso.endsWith("Z")) {
    return new Date(Date.parse(iso) + ms).toISOString();
  }
  // Kept offset: insert the fraction before it.
  return iso.replace(/([+-]\d{2}:\d{2})$/, `.${String(ms).padStart(3, "0")}$1`);
}

/**
 * A carrier timestamp as ISO 8601 UTC, or null when it does not parse. Strings that carry their
 * own offset keep it; strings without one are read as `options.naive` says.
 */
export function isoTime(value: unknown, options: TimeOptions): string | null {
  if (typeof value === "number") {
    const unit = options.epoch ?? "none";
    return unit === "none" ? null : epochIso(value, unit);
  }
  if (options.naive === "runtime") {
    if (typeof value !== "string" || value.trim() === "") {
      return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const raw = text(value, { numbers: false });
  if (raw === null) {
    return null;
  }
  if (options.epochStrings === true && /^\d{10,13}$/.test(raw)) {
    return epochIso(Number(raw), "auto");
  }
  if (HAS_OFFSET.test(raw)) {
    const at = Date.parse(raw.replace(" ", "T"));
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  return naiveIso(raw, options);
}

/**
 * Reads the digits of a local date-time in the given field order, e.g. `20261118 143000`,
 * `2026-11-18T14:30:00` or, with `DMY`, `18/11/2026 14:30`, as wall-clock time in `zone`. A
 * string that already carries an offset is passed through as an instant.
 */
export function parseLocal(
  value: unknown,
  zone: string,
  order: "YMD" | "DMY" = "YMD",
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (/\d(Z|[+-]\d{2}:?\d{2})$/i.test(raw) && /^\d{4}-/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const compact = /^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(raw);
  const pattern =
    order === "YMD"
      ? /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
      : /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
  const parts = compact?.slice(1) ?? pattern.exec(raw)?.slice(1);
  if (parts === undefined) {
    return null;
  }
  // Optional groups that did not match are undefined at run time, whatever the type says.
  const [a, b, c, h, mi, s] = parts.map((part: string | undefined) => Number(part ?? 0));
  const ymd = order === "YMD" || compact !== null ? [a, b, c] : [c, b, a];
  return zonedIso(
    {
      year: ymd[0] ?? 0,
      month: ymd[1] ?? 0,
      day: ymd[2] ?? 0,
      hour: h ?? 0,
      minute: mi ?? 0,
      second: s ?? 0,
    },
    zone,
  );
}

/** The first and last second of the local day an instant falls on. */
export function localDay(iso: string, timeZone: string): { from: string; to: string } | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const { year, month, day } = wallTimeAt(at, timeZone);
  const from = zonedIso({ year, month, day }, timeZone);
  const to = zonedIso({ year, month, day, hour: 23, minute: 59, second: 59 }, timeZone);
  return from === null || to === null ? null : { from, to };
}

/** A whole local day given as `YYYY-MM-DD` (or `YYYYMMDD`): midnight to 23:59:59 in `zone`. */
export function dayWindow(day: string | null, zone: string): { from: string; to: string } | null {
  const date = day === null ? null : /^(\d{4})-?(\d{2})-?(\d{2})/.exec(day.trim());
  if (date === null) {
    return null;
  }
  const wall = { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) };
  const from = zonedIso(wall, zone);
  const to = zonedIso({ ...wall, hour: 23, minute: 59, second: 59 }, zone);
  return from === null || to === null ? null : { from, to };
}

/** Sort key; unparseable values sort last when sorting newest first. */
export function epoch(iso: string | null): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** Entries with an `at` timestamp, newest first, the order snapshots carry history in. */
export function newestFirst<T extends { readonly at: string }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => epoch(b.at) - epoch(a.at));
}
