import type { ParcelSnapshot } from "../../plugin/api.js";

/** The canonical status values, taken from the plug-in API. */
export type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/** Helpers for untrusted JSON and local carrier clocks. */
export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string or number as trimmed text; null when absent or empty. */
export function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** A wall-clock time in `timeZone` as an ISO instant; null when the parts are not a real date. */
export function zonedIso(clock: WallClock, timeZone: string): string | null {
  const guess = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  const check = new Date(guess);
  if (
    Number.isNaN(guess) ||
    check.getUTCDate() !== clock.day ||
    check.getUTCMonth() !== clock.month - 1 ||
    clock.hour > 23 ||
    clock.minute > 59 ||
    clock.second > 59
  ) {
    return null;
  }
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone)).toISOString();
}

/** The string itself, or null when it is missing or empty. */
export function nonEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}
