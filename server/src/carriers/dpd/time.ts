/** Date helpers for DPD Germany, whose pages show local German days and times without offsets. */

const ZONE = "Europe/Berlin";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A day shown without a year more than this far ahead of today belongs to the previous year. */
const FUTURE_TOLERANCE_DAYS = 7;

export interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  timeZoneName: "longOffset",
});
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The zone's offset at an instant, as `+01:00`. */
function offsetAt(instant: number): string {
  const name = offsetFormat.formatToParts(instant).find((part) => part.type === "timeZoneName");
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name?.value ?? "");
  return match?.[1] ?? "+00:00";
}

const pad = (value: number): string => String(value).padStart(2, "0");

function isRealDay({ year, month, day }: Day): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * A local wall-clock time in Germany as ISO 8601 with its offset. The offset is taken a few
 * hours earlier in UTC, which lands on the same side of a DST switch (02:00/03:00 local).
 */
export function localIso(day: Day, hour = 0, minute = 0, second = 0): string {
  const utcGuess = Date.UTC(day.year, day.month - 1, day.day, hour, minute, second);
  const offset = offsetAt(utcGuess - 3 * HOUR_MS);
  return `${day.year}-${pad(day.month)}-${pad(day.day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset}`;
}

/** Today in Germany. */
export function todayIn(now: Date): Day {
  const [year, month, day] = dayFormat.format(now).split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

const ordinal = (day: Day): number => Date.UTC(day.year, day.month - 1, day.day) / DAY_MS;

/**
 * Gives each `DD.MM.` day its year, in order. A day more than a week after today belongs to the
 * previous year, and a later entry never falls before an earlier one. Unreadable days are null.
 */
export function inferYears(raw: readonly string[], today: Day): (Day | null)[] {
  let previous: Day | null = null;
  return raw.map((text) => {
    const match = /^(\d{1,2})\.(\d{1,2})\.$/.exec(text.trim());
    if (match === null) {
      return null;
    }
    const day = Number(match[1]);
    const month = Number(match[2]);
    let candidate: Day = { year: today.year, month, day };
    if (ordinal(candidate) > ordinal(today) + FUTURE_TOLERANCE_DAYS) {
      candidate = { ...candidate, year: today.year - 1 };
    }
    if (previous !== null && ordinal(candidate) < ordinal(previous)) {
      candidate = { ...candidate, year: candidate.year + 1 };
    }
    if (!isRealDay(candidate)) {
      return null;
    }
    previous = candidate;
    return candidate;
  });
}

/** The day a sentence names: `Geliefert am: 09.10.` or `… 29.10.2026`. */
export function dayInSentence(sentence: string, today: Day): Day | null {
  const match = /(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec(sentence);
  if (match === null) {
    return null;
  }
  if (match[3] === undefined) {
    return inferYears([`${match[1] ?? ""}.${match[2] ?? ""}.`], today)[0] ?? null;
  }
  const day: Day = { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
  return isRealDay(day) ? day : null;
}

/** `2026-11-18T09:15:00` (local German time, no offset) as ISO 8601 with offset. */
export function localTimestamp(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
  if (match === null) {
    return null;
  }
  const day: Day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!isRealDay(day)) {
    return null;
  }
  return localIso(day, Number(match[4]), Number(match[5]), Number(match[6] ?? "0"));
}
