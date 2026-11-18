/** Timestamp handling. History and windows need an offset; values without one are local time. */

const ZONED = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

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

/** The wall-clock fields of an instant in a zone. */
function wallClock(epochMs: number, timeZone: string): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  return fields;
}

function offsetMs(epochMs: number, timeZone: string): number {
  const f = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(
    f["year"] ?? 0,
    (f["month"] ?? 1) - 1,
    f["day"],
    f["hour"],
    f["minute"],
    f["second"],
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Converts a local wall-clock time in `timeZone` to an instant. */
function localToEpoch(
  parts: readonly [number, number, number, number, number, number],
  timeZone: string,
): number {
  const [year, month, day, hour, minute, second] = parts;
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - offsetMs(guess, timeZone);
  return guess - offsetMs(first, timeZone);
}

/**
 * Normalises a carrier timestamp to ISO 8601 UTC. Values with an offset are taken as they are;
 * values without one are read as wall-clock time in `localZone`, or rejected when no zone is
 * known, so a local time is never passed off as UTC.
 */
export function toIso(value: unknown, localZone: string | null): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const text = value.trim();
  if (HAS_OFFSET.test(text)) {
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  const match = ZONED.exec(text);
  if (match === null || localZone === null) {
    return null;
  }
  const n = (index: number): number => Number(match[index] ?? "0");
  return new Date(localToEpoch([n(1), n(2), n(3), n(4), n(5), n(6)], localZone)).toISOString();
}

/** The last second of the local day `iso` falls on: a single date means "that day". */
export function endOfLocalDay(iso: string, timeZone: string): string {
  const f = wallClock(Date.parse(iso), timeZone);
  const epoch = localToEpoch(
    [f["year"] ?? 0, f["month"] ?? 1, f["day"] ?? 1, 23, 59, 59],
    timeZone,
  );
  return new Date(epoch).toISOString();
}

/** Sort key for ISO timestamps; unparseable values sort first. */
export function epoch(iso: string | null): number {
  if (iso === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}
