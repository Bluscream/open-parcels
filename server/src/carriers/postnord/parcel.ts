import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import { asObject, instantIso, num, objects, text, type Json } from "../../plugin/parse.js";

export const CARRIER_ID = "postnord";
type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/*
 * PostNord's machine status, shared by shipments and their events. The shared rules have no
 * PostNord table yet; this table and the two event codes below belong there.
 */
const STATUSES: Readonly<Record<string, ParcelStatus>> = {
  CREATED: "registered",
  INFORMED: "registered",
  EN_ROUTE: "in_transit",
  AVAILABLE_FOR_DELIVERY: "at_pickup_point",
  DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
  DELIVERY_IMPOSSIBLE: "problem",
  EXPECTED_DELAY: "problem",
  RETURNED: "returning",
  STOPPED: "problem",
  DELAYED: "problem",
  DELIVERY_REFUSED: "returning",
};
/** "Delivery in progress": the shipment still says EN_ROUTE. */
const OUT_FOR_DELIVERY_EVENT = "113";
/** Extended retention at the pickup point. */
const RETENTION_EVENTS = new Set(["45", "z2F"]);
/** Events with status OTHER say nothing new and inherit the stage before them. */
const OTHER = "OTHER";

interface Event {
  readonly at: string;
  readonly event: Json;
}

function events(raw: Json): Event[] {
  return objects(raw["items"])
    .flatMap((item) => objects(item["events"]))
    .map((event) => ({ event, at: instantIso(event["eventTime"]) }))
    .filter((entry): entry is Event => entry.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** PostNord sends event codes as strings or numbers. */
function eventCode(event: Json): string {
  const code = event["eventCode"];
  return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

function eventStatus(event: Json): ParcelStatus | null {
  const code = eventCode(event);
  if (code === OUT_FOR_DELIVERY_EVENT) {
    return "out_for_delivery";
  }
  if (RETENTION_EVENTS.has(code)) {
    return "at_pickup_point";
  }
  return STATUSES[text(event["status"]) ?? ""] ?? null;
}

/** History newest first; OTHER events carry the previous stage forward. */
function history(ordered: readonly Event[]): SnapshotEvent[] {
  let previous: ParcelStatus | null = null;
  const entries: SnapshotEvent[] = [];
  for (const { event, at } of ordered) {
    let status = eventStatus(event);
    if (status === null && event["status"] === OTHER) {
      status = previous;
    }
    previous = status ?? previous;
    const rawStatus = text(event["eventDescription"]) ?? eventCode(event);
    if (rawStatus !== "") {
      entries.push({
        at,
        status,
        rawStatus,
        location: text(asObject(event["location"])["displayName"]),
      });
    }
  }
  return entries.reverse();
}

function weightKg(raw: Json): number | null {
  const first = objects(raw["items"])[0] ?? {};
  const candidates = [
    raw["totalWeight"],
    raw["assessedWeight"],
    asObject(first["statedMeasurement"])["weight"],
    asObject(first["assessedMeasurement"])["weight"],
    first["weight"],
  ];
  for (const candidate of candidates) {
    const weight = asObject(candidate);
    const value = num(weight["value"]);
    const factor = { kg: 1, g: 0.001 }[String(weight["unit"]).toLowerCase()];
    if (value !== null && factor !== undefined && value > 0) {
      return value * factor;
    }
  }
  return null;
}

function pickupPoint(raw: Json, ordered: readonly Event[]): string | null {
  for (const key of ["destinationDeliveryPoint", "deliveryPoint"]) {
    const name = text(asObject(raw[key])["name"]);
    if (name !== null) {
      return name;
    }
  }
  const waiting = ordered
    .filter(({ event }) => event["status"] === "AVAILABLE_FOR_DELIVERY")
    .at(-1);
  return waiting === undefined ? null : text(asObject(waiting.event["location"])["locationName"]);
}

export function shipmentSnapshot(
  raw: Json,
  code: string,
  report: (status: string) => void,
): ParcelSnapshot {
  const ordered = events(raw);
  const statusCode = text(raw["status"]);
  let status = statusCode === null ? null : (STATUSES[statusCode] ?? null);
  if (statusCode !== null && status === null) {
    report(statusCode);
  }
  const newest = ordered.at(-1)?.event;
  if (status === "in_transit" && eventCode(newest ?? {}) === OUT_FOR_DELIVERY_EVENT) {
    status = "out_for_delivery";
  }
  // A return ends with a DELIVERED event while the shipment keeps saying RETURNED.
  if (status === "returning" && newest?.["status"] === "DELIVERED") {
    status = "delivered";
  }
  const delivered = status === "delivered";
  const deliveries = ordered.filter(({ event }) => event["status"] === "DELIVERED");
  const shipmentId = text(raw["shipmentId"]) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: shipmentId,
    status,
    rawStatus: text(asObject(raw["statusText"])["header"]) ?? statusCode,
    delivered,
    deliveredAt: delivered ? (deliveries.at(-1)?.at ?? null) : null,
    plannedFrom: delivered ? null : instantIso(raw["estimatedTimeOfArrival"]),
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(raw, ordered),
    url: `https://tracking.postnord.com/en/tracking?id=${encodeURIComponent(shipmentId)}`,
    sender: text(asObject(raw["consignor"])["name"]),
    receiver: text(asObject(raw["consignee"])["name"]),
    weightKg: weightKg(raw),
    history: history(ordered),
    raw,
  });
}
