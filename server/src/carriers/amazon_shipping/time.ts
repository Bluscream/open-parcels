import { isoTime, zonedIso, type WallTime } from "../../plugin/api.js";

/**
 * A tracker time. `sortKey` orders events within one parcel (local times are compared as they
 * read); `iso` is the real instant, or null when the time has no offset and no zone is known.
 */
export interface Moment {
  readonly sortKey: number;
  readonly iso: string | null;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** "Oct 8, 2026, 6:14:30 AM": always US English, with a narrow no-break space before AM/PM. */
const US_LONG =
  /^([A-Za-z]{3}) (\d{1,2}), (\d{4})(?:, (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp][Mm]))?$/;
const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
/** The narrow and plain no-break spaces the tracker puts inside its dates. */
const ODD_SPACES = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, "g");

function fromWall(wall: WallTime, zone: string | null): Moment {
  const sortKey = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  );
  return { sortKey, iso: zone === null ? null : zonedIso(wall, zone) };
}

function usLong(value: string): WallTime | null {
  const match = US_LONG.exec(value);
  if (match === null) {
    return null;
  }
  const month = MONTHS.indexOf((match[1] ?? "").toUpperCase()) + 1;
  let hour = Number(match[4] ?? "0");
  const meridiem = (match[7] ?? "").toUpperCase();
  if (month === 0 || (meridiem !== "" && (hour < 1 || hour > 12))) {
    return null;
  }
  if (meridiem !== "") {
    hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
  }
  return {
    year: Number(match[3]),
    month,
    day: Number(match[2]),
    hour,
    minute: Number(match[5] ?? "0"),
    second: Number(match[6] ?? "0"),
  };
}

export function parseMoment(value: unknown, zone: string | null): Moment | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000;
    return { sortKey: ms, iso: new Date(ms).toISOString() };
  }
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(ODD_SPACES, " ").trim();
  const wall = usLong(cleaned);
  if (wall !== null) {
    return fromWall(wall, zone);
  }
  const exact = isoTime(cleaned, { naive: "reject" });
  if (exact !== null) {
    return { sortKey: Date.parse(exact), iso: exact };
  }
  const local = LOCAL_ISO.exec(cleaned);
  if (local === null) {
    return null;
  }
  const n = (index: number): number => Number(local[index] ?? "0");
  return fromWall(
    { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) },
    zone,
  );
}
