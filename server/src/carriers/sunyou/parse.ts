import {
  ruleStatus,
  asObject,
  isoTime,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "sunyou";

function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

/**
 * `createTime` is a wall time; each event carries its own `timeZone` offset (`+08:00`). Without
 * one the time is read as UTC rather than dropping the event.
 */
export function eventTime(event: Json): string | null {
  const wall = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text(event["createTime"]) ?? "");
  if (wall === null) {
    return null;
  }
  const zone = text(event["timeZone"]);
  const offset = zone !== null && /^[+-]\d{2}:\d{2}$/.test(zone) ? zone : "Z";
  return isoTime(`${wall[1] ?? ""}T${wall[2] ?? ""}`, { naive: { offset } });
}

/** Every leg's events; only `origin` has been seen, but any leg is read. */
function collect(raw: Json): Json[] {
  const events: Json[] = [];
  for (const leg of Object.values(asObject(raw["result"]))) {
    const items = asObject(leg)["items"];
    if (Array.isArray(items)) {
      events.push(...items.map(asObject));
    }
  }
  return events;
}

/**
 * Turns one `data[0]` entry into a snapshot. The barcode is SunYou's `orderNo`; the last-mile
 * carrier's number is a different parcel identity and stays in the raw payload.
 */
export function orderSnapshot(
  raw: Json,
  requested: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const dated: { at: string; event: Json }[] = [];
  for (const event of collect(raw)) {
    const at = eventTime(event);
    if (at !== null) {
      dated.push({ at, event });
    }
  }
  dated.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const history: SnapshotEvent[] = dated.map(({ at, event }) => ({
    at,
    status: mapCode(text(event["status"])),
    rawStatus: text(event["eventCode"]) ?? text(event["status"]) ?? "?",
    location: null,
  }));
  const newest = dated[0];
  const code = newest === undefined ? null : text(newest.event["status"]);
  const status = mapCode(code);
  if (code !== null && status === null) {
    report(code);
  }
  const barcode = text(raw["orderNo"]) ?? requested;
  // `displayStatus` is a coarse UI bucket that disagrees with the events; it is not kept.
  const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "displayStatus"));
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: newest === undefined ? null : (text(newest.event["eventCode"]) ?? code),
    deliveredAt: status === "delivered" ? (newest?.at ?? null) : null,
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    history,
    raw: kept,
  });
}
