import type { ParcelStatus } from "../../domain/parcel.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "speedx";

export type Json = Readonly<Record<string, unknown>>;

function text(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Categories first, then numeric event codes. `unknown` marks codes we have seen but that say
 * nothing about where the parcel is (an intercept, an internal hold).
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  PICKUP: "registered",
  ORIGIN_HANDLING: "in_transit",
  LAST_MILE_ENROUTE: "in_transit",
  LAST_MILE_DELIVERED: "delivered",
  LAST_MILE_ATTEMPTED: "problem",
  LAST_MILE_UNDELIVERED: "problem",
  LAST_MILE_INTERCEPT: "unknown",
  "50001": "registered",
  "50002": "in_transit",
  "52001": "in_transit",
  "52002": "in_transit",
  "57101": "in_transit",
  "57102": "in_transit",
  "57104": "in_transit",
  "57110": "in_transit",
  "57112": "in_transit",
  "57113": "in_transit",
  "57201": "delivered",
  "57406": "unknown",
  "57409": "in_transit",
  "57413": "problem",
  "57504": "problem",
  "57607": "problem",
  "57609": "problem",
  "57614": "problem",
  "57645": "problem",
  // A disposal after failed attempts is a dead end, not a return.
  "59116": "problem",
};

function eventKey(event: Json): string | null {
  return text(event["category"]) ?? text(event["eventCode"]);
}

function mapEvent(event: Json): ParcelStatus | null {
  const key = eventKey(event);
  if (key === null) {
    return null;
  }
  const description = (text(event["eventDescription"]) ?? "").toLowerCase();
  if (key === "LAST_MILE_ENROUTE" && description.includes("out for delivery")) {
    return "out_for_delivery";
  }
  return STATUS_MAP[key] ?? null;
}

function zoneOffsetMinutes(zone: string, utcMs: number): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(utcMs))
      .find((part) => part.type === "timeZoneName")?.value;
    if (name === "GMT") {
      return 0;
    }
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
    if (match === null) {
      return null;
    }
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return null;
  }
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** `localTs` usually carries its offset; a bare wall time is placed in the event's `timeZone`. */
export function eventTime(event: Json): string | null {
  const local = text(event["localTs"]);
  if (local === null) {
    return null;
  }
  const wall = WALL.exec(local);
  if (wall === null) {
    const parsed = new Date(local);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const zone = text(event["timeZone"]);
  if (zone === null) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = wall;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const first = zoneOffsetMinutes(zone, asUtc);
  const second = first === null ? null : zoneOffsetMinutes(zone, asUtc - first * 60_000);
  return second === null ? null : new Date(asUtc - second * 60_000).toISOString();
}

/** Turns the event list (newest first) into a snapshot; `report` receives unmapped codes. */
export function eventsSnapshot(
  events: readonly Json[],
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const seen = new Set<string>();
  const history: SnapshotEvent[] = [];
  for (const event of events) {
    const identity = JSON.stringify([
      event["eventCode"],
      event["localTs"],
      event["category"],
      event["eventDescription"],
    ]);
    const at = eventTime(event);
    const rawStatus = text(event["eventCode"]) ?? eventKey(event);
    if (seen.has(identity) || at === null || rawStatus === null) {
      continue;
    }
    seen.add(identity);
    history.push({ at, status: mapEvent(event), rawStatus, location: null });
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = events[0] ?? {};
  const key = eventKey(newest);
  const status = mapEvent(newest);
  if (key !== null && status === null) {
    report(key);
  }
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(newest["eventCode"]) ?? key,
    deliveredAt: status === "delivered" ? eventTime(newest) : null,
    url: `https://tracking.speedx.io/${encodeURIComponent(barcode)}`,
    history,
    raw: { eventCode: newest["eventCode"], category: newest["category"] },
  });
}
