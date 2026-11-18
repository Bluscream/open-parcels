import { parseArrival, type Rules } from "open-parcels-rules";
import { foldText } from "./text.js";

/** A calendar day in the page's zone. */
export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Words for "today" and "yesterday" on their own, as timeline headers and delivered lines use
 * them. The rules' locale tables only read relative days inside arrival phrases, so this minimal
 * en/de list stays here until the tables cover standalone past days.
 */
const RELATIVE_PAST: Readonly<Record<string, number>> = {
  today: 0,
  heute: 0,
  yesterday: -1,
  gestern: -1,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export function isTimeZone(name: string): boolean {
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

function wallClock(at: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    parts["year"] ?? 1970,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
}

export function today(now: Date, timeZone: string): Day {
  const local = new Date(wallClock(now, timeZone));
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

function shift(day: Day, days: number): Day {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

const ordinal = (day: Day): number => Date.UTC(day.year, day.month - 1, day.day);

const pad = (value: number): string => String(value).padStart(2, "0");

/** ISO 8601 with the zone's offset for a wall-clock time on `day`. */
export function zonedIso(day: Day, hour: number, minute: number, timeZone: string): string {
  const wanted = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let instant = wanted;
  for (let round = 0; round < 2; round += 1) {
    instant = wanted - (wallClock(new Date(instant), timeZone) - instant);
  }
  const offsetMinutes = Math.round((wallClock(new Date(instant), timeZone) - instant) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const local = new Date(wallClock(new Date(instant), timeZone));
  return (
    `${String(local.getUTCFullYear())}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function dayOfIso(iso: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) {
    return null;
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The delivery window an order line or promise message names, read with the locale tables. */
export function arrivalWindow(
  rules: Rules,
  text: string | null,
  now: Date,
  timeZone: string,
): { from: string; to: string } | null {
  if (text === null || text.trim() === "") {
    return null;
  }
  const window = parseArrival(rules, text, { now, timeZone });
  return window === null ? null : { from: window.from, to: window.to };
}

/**
 * A day in the past named by a timeline header ("Dienstag, 3. November", "Today") or a delivered
 * line ("Delivered 12 November"). The locale tables read dates forward, so a day that lands more
 * than two days ahead is taken to be last year's.
 */
export function pastDay(rules: Rules, text: string, now: Date, timeZone: string): Day | null {
  const reference = today(now, timeZone);
  const words = foldText(text).split(/[\s,]+/);
  for (const word of words) {
    const offset = RELATIVE_PAST[word];
    if (offset !== undefined) {
      return shift(reference, offset);
    }
  }
  // "Delivered 12 November": the status word in front keeps the tables from matching the date.
  const candidates = [text, text.replace(/^\s*\S+\s+/, "")];
  for (const candidate of candidates) {
    const window = parseArrival(rules, candidate, { now, timeZone });
    const found = window === null ? null : dayOfIso(window.from);
    if (found !== null) {
      return ordinal(found) > ordinal(shift(reference, 2))
        ? { ...found, year: found.year - 1 }
        : found;
    }
  }
  return null;
}

/** "14:23", "2:23 PM" or "2:23 p.m." as hours and minutes. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?\.?$/i.exec(text.trim());
  if (match === null) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? null : { hour, minute };
}
