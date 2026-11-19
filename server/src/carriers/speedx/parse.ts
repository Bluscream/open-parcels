import {
  ruleStatus,
  isTimeZone,
  snapshot,
  text,
  zonedIso,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "speedx";

import type { Json } from "../../plugin/api.js";

export type { Json };

/**
 * The category first, then the numeric event code. The shared table maps codes seen that say
 * nothing about where the parcel is (an intercept, an internal hold) to `unknown`.
 */
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
  return ruleStatus(CARRIER_ID, key);
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
  if (zone === null || !isTimeZone(zone)) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = wall;
  return zonedIso(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s ?? 0),
    },
    zone,
  );
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
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    history,
    raw: { eventCode: newest["eventCode"], category: newest["category"] },
  });
}
