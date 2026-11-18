/** Local wall-clock times without an offset, turned into ISO 8601 with the zone's real offset. */

const HOUR_MS = 3_600_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function offsetFormat(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    formats.set(zone, format);
  }
  return format;
}

/** The zone's offset at an instant, as `+01:00`. */
function offsetAt(zone: string, instant: number): string {
  const name = offsetFormat(zone)
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName");
  const match = /GMT([+-]\d{2}:\d{2})/.exec(name?.value ?? "");
  return match?.[1] ?? "+00:00";
}

const pad = (value: number): string => String(value).padStart(2, "0");

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

/**
 * ISO 8601 for a wall-clock time in `zone`, or null when the date does not exist. The offset is
 * taken a few hours earlier in UTC, which lands on the same side of a DST switch.
 */
export function zonedIso(time: WallTime, zone: string): string | null {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = time;
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const offset = offsetAt(zone, probe.getTime() - 3 * HOUR_MS);
  const local = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  return new Date(`${local}${offset}`).toISOString();
}

/**
 * Reads the digits of a local date-time in the given field order (`YMDhms` by default), e.g.
 * `20261118 143000`, `2026-11-18T14:30:00` or, with `DMYhms`, `18/11/2026 14:30`. A string
 * that already carries a zone is passed through as an instant.
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
  const parts =
    compact?.slice(1) ??
    (order === "YMD"
      ? /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
          .exec(raw)
          ?.slice(1)
      : /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
          .exec(raw)
          ?.slice(1));
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

/** A whole local day as a window: midnight to 23:59:59 in `zone`. */
export function dayWindow(day: string | null, zone: string): { from: string; to: string } | null {
  if (day === null) {
    return null;
  }
  const from = parseLocal(day, zone);
  const date = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(day.trim());
  if (from === null || date === null) {
    return null;
  }
  const to = zonedIso(
    {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 23,
      minute: 59,
      second: 59,
    },
    zone,
  );
  return to === null ? null : { from, to };
}
