import {
  asObject,
  epoch,
  objects,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { publicTrackingUrl } from "./keys.js";
import { upsStatus, type Vocabulary } from "./status.js";

type Deps = Pick<PluginContext<unknown, unknown>, "reportUnknown">;

/** Maps a key and reports it when neither the rules nor the local table know it. */
export function mapAndReport(
  deps: Deps,
  vocabulary: Vocabulary,
  key: string | null,
): SnapshotEvent["status"] {
  if (key === null) {
    return null;
  }
  const { status, unknown } = upsStatus(vocabulary, key);
  if (unknown) {
    deps.reportUnknown(`${vocabulary}_code`, key);
  }
  return status;
}

/** The parcel's current milestone key: the current milestone, a flagged one, or the newest scan's. */
function currentMilestone(raw: Json): string | null {
  const current = text(asObject(raw["currentMilestone"])["nameKey"]);
  if (current !== null) {
    return current;
  }
  const flagged = objects(raw["milestones"]).find((m) => m["isCurrent"] === true);
  const fromFlagged = text(flagged?.["nameKey"]);
  if (fromFlagged !== null) {
    return fromFlagged;
  }
  // Activities come newest first.
  const newest = objects(raw["shipmentProgressActivities"])[0];
  return text(asObject(newest?.["milestoneName"])["nameKey"]);
}

const GMT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;

/** An activity's UTC date (`YYYYMMDD`) and time (`HH:MM:SS`), never the localised strings. */
function gmtInstant(date: unknown, time: unknown, offset = "Z"): string | null {
  const day = GMT_DATE.exec(text(date) ?? "");
  const clock = CLOCK.exec(text(time) ?? "");
  if (day === null || clock === null) {
    return null;
  }
  const parsed = Date.parse(`${day[1] ?? ""}-${day[2] ?? ""}-${day[3] ?? ""}T${clock[0]}${offset}`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function location(activity: Json): string | null {
  const place = asObject(activity["location"]);
  return text(place["city"]) ?? text(place["location"]) ?? text(activity["location"]);
}

function history(deps: Deps, raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const activity of objects(raw["shipmentProgressActivities"])) {
    const at = gmtInstant(activity["gmtDate"], activity["gmtTime"]);
    if (at === null) {
      continue;
    }
    const milestone = text(asObject(activity["milestoneName"])["nameKey"]);
    const scan = text(activity["actCode"]);
    // Most scans carry no milestone; the scan code is the other status-bearing field.
    const status =
      milestone !== null
        ? mapAndReport(deps, "milestone", milestone)
        : mapAndReport(deps, "scan", scan);
    events.push({ at, status, rawStatus: milestone ?? scan ?? "", location: location(activity) });
  }
  return events.sort((a, b) => epoch(a.at) - epoch(b.at));
}

/**
 * The estimate window from `sdd` (YYYYMMDD) with `sdst`/`sdt` (HH:MM:SS), local to the recipient.
 * `shipmentGMTInfo.shipToGMTOffset` is the only offset that matches it; without it the window is
 * dropped rather than relabelled as UTC.
 */
function plannedWindow(raw: Json): { from: string | null; to: string | null } {
  const offset = text(asObject(raw["shipmentGMTInfo"])["shipToGMTOffset"]);
  if (offset === null || !/^[+-]\d{2}:\d{2}$/.test(offset)) {
    return { from: null, to: null };
  }
  const from = gmtInstant(raw["sdd"], raw["sdst"], offset);
  const to = gmtInstant(raw["sdd"], raw["sdt"], offset);
  return from === null || to === null ? { from: null, to: null } : { from, to };
}

function weightKg(raw: Json): number | null {
  const info = asObject(raw["additionalInformation"]);
  const value = Number(text(info["weight"]) ?? "");
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = (text(info["weightUnit"]) ?? "").toUpperCase();
  if (unit === "KGS") {
    return value;
  }
  return unit === "LBS" ? Math.round(value * 0.45359237 * 1000) / 1000 : null;
}

/**
 * The fields of a lookup worth keeping. UPS answers with over a hundred, mostly page furniture;
 * addresses and the proof-of-delivery link are left out.
 */
const KEPT_FIELDS = [
  "trackingNumber",
  "packageStatus",
  "packageStatusCode",
  "packageStatusType",
  "currentMilestone",
  "milestones",
  "sdd",
  "sdst",
  "sdt",
  "shipmentGMTInfo",
  "isDelivered",
  "additionalInformation",
  "errorCode",
] as const;

/** `code` is the number the user entered; UPS may echo a different one, kept in `raw`. */
export function normalizePublic(
  deps: Deps,
  code: string,
  raw: Json,
  locale: string,
): ParcelSnapshot {
  const milestone = currentMilestone(raw);
  const status = mapAndReport(deps, "milestone", milestone);
  const events = history(deps, raw);
  // `isDelivered` also marks a parcel handed back to the sender; the newest scan is when it ended.
  const delivered = raw["isDelivered"] === true;
  const deliveredAt = delivered
    ? (events.findLast((e) => e.rawStatus === "cms.stapp.delivered")?.at ??
      events.at(-1)?.at ??
      null)
    : null;
  const window = delivered ? { from: null, to: null } : plannedWindow(raw);
  return snapshot({
    carrier: "ups",
    barcode: code,
    status,
    rawStatus: milestone ?? text(raw["packageStatus"]),
    delivered,
    deliveredAt,
    plannedFrom: window.from,
    plannedTo: window.to,
    pickup: status === "at_pickup_point",
    url: publicTrackingUrl(code, locale),
    weightKg: weightKg(raw),
    history: events,
    raw: Object.fromEntries(KEPT_FIELDS.filter((k) => k in raw).map((k) => [k, raw[k]])),
  });
}
