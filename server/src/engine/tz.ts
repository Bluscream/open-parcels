/** Minimal time-zone arithmetic on top of Intl, correct across daylight-saving changes. */

export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values["year"] ?? 0,
    month: values["month"] ?? 1,
    day: values["day"] ?? 1,
    hour: values["hour"] ?? 0,
    minute: values["minute"] ?? 0,
  };
}

/** Offset of the zone from UTC at `date`, in milliseconds (positive east of Greenwich). */
function offsetMs(date: Date, timeZone: string): number {
  const parts = localParts(date, timeZone);
  const seconds = date.getUTCSeconds();
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, seconds);
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/**
 * The instant at which the wall clock in `timeZone` shows the given local time. For a time that
 * does not exist (spring-forward gap) the result is the first valid instant after it.
 */
export function zonedTime(local: LocalParts, timeZone: string): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(Math.max(first, second));
}

/** Local midnight of the day after `date`. */
export function nextLocalMidnight(date: Date, timeZone: string): Date {
  const today = localParts(date, timeZone);
  const noonUtc = Date.UTC(today.year, today.month - 1, today.day, 12) + 24 * 60 * 60 * 1000;
  const tomorrow = new Date(noonUtc);
  return zonedTime(
    {
      year: tomorrow.getUTCFullYear(),
      month: tomorrow.getUTCMonth() + 1,
      day: tomorrow.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    timeZone,
  );
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
