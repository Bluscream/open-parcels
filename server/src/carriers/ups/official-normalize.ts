import {
  asObject,
  epoch,
  num,
  objects,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { publicTrackingUrl } from "./keys.js";
import { mapAndReport } from "./public-normalize.js";

/*
 * Field names follow UPS's Tracking API documentation (`trackResponse.shipment[].package[]`);
 * no live answer has been seen yet.
 */

type Deps = Pick<PluginContext<unknown, unknown>, "reportUnknown">;

const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const TIME = /^(\d{2}):?(\d{2}):?(\d{2})$/;

/** `YYYYMMDD` and `HHMMSS` (or `HH:MM:SS`) with an offset such as `-05:00`, as an instant. */
function instant(date: unknown, time: unknown, offset: string): string | null {
  const day = DATE.exec(text(date) ?? "");
  const clock = TIME.exec(text(time) ?? "");
  if (day === null || clock === null || !/^(?:Z|[+-]\d{2}:\d{2})$/.test(offset)) {
    return null;
  }
  const at = Date.parse(
    `${day[1] ?? ""}-${day[2] ?? ""}-${day[3] ?? ""}T${clock[1] ?? ""}:${clock[2] ?? ""}:${clock[3] ?? ""}${offset}`,
  );
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** An activity's time: the GMT pair when present, never the local pair without an offset. */
function activityTime(activity: Json): string | null {
  return instant(activity["gmtDate"], activity["gmtTime"], "Z");
}

function place(activity: Json): string | null {
  const address = asObject(asObject(activity["location"])["address"]);
  return text(address["city"]);
}

function statusType(activity: Json): string | null {
  return text(asObject(activity["status"])["type"]);
}

function weightKg(pkg: Json): number | null {
  const weight = asObject(pkg["weight"]);
  const value = num(weight["weight"]);
  const unit = (
    text(asObject(weight["unitOfMeasurement"])["code"]) ??
    text(weight["unitOfMeasurement"]) ??
    ""
  ).toUpperCase();
  if (value === null || value <= 0) {
    return null;
  }
  if (unit === "KGS") {
    return value;
  }
  return unit === "LBS" ? Math.round(value * 0.45359237 * 1000) / 1000 : null;
}

export function normalizeOfficial(
  deps: Deps,
  code: string,
  pkg: Json,
  locale: string,
): ParcelSnapshot {
  const history: SnapshotEvent[] = [];
  for (const activity of objects(pkg["activity"])) {
    const at = activityTime(activity);
    const type = statusType(activity);
    if (at !== null) {
      history.push({
        at,
        status: mapAndReport(deps, "type", type),
        rawStatus: text(asObject(activity["status"])["description"]) ?? type ?? "",
        location: place(activity),
      });
    }
  }
  history.sort((a, b) => epoch(a.at) - epoch(b.at));
  // Activities come newest first; the newest one is the current state.
  const latest = objects(pkg["activity"])[0];
  const latestType = latest === undefined ? null : statusType(latest);
  const status = mapAndReport(deps, "type", latestType);
  const delivered = status === "delivered";
  return snapshot({
    carrier: "ups",
    barcode: code,
    status,
    rawStatus: text(asObject(pkg["currentStatus"])["description"]) ?? latestType,
    delivered,
    deliveredAt: delivered ? (history.findLast((e) => e.status === "delivered")?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    url: publicTrackingUrl(code, locale),
    weightKg: weightKg(pkg),
    history,
    raw: {
      trackingNumber: pkg["trackingNumber"],
      currentStatus: pkg["currentStatus"],
      deliveryDate: pkg["deliveryDate"],
      deliveryTime: pkg["deliveryTime"],
    },
  });
}
