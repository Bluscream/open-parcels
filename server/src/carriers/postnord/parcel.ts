import {
  asObject,
  isoTime,
  num,
  objects,
  ruleStatus,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "postnord";
const STRINGS = { numbers: false } as const;
const DECIMAL = { decimalComma: true } as const;
const INSTANT = { naive: "utc", epoch: "ms" } as const;

/** "Delivery in progress": the shipment still says EN_ROUTE. */
const OUT_FOR_DELIVERY_EVENT = "113";

/** The machine status ("status:") shared by shipments and their events, from the shared table. */
const statusOf = (status: string | null): ParcelStatus | null =>
  status === null ? null : ruleStatus(CARRIER_ID, `status:${status}`);
/** Events with status OTHER say nothing new and inherit the stage before them. */
const OTHER = "OTHER";

interface Event {
  readonly at: string;
  readonly event: Json;
}

function events(raw: Json): Event[] {
  return objects(raw["items"])
    .flatMap((item) => objects(item["events"]))
    .map((event) => ({ event, at: isoTime(event["eventTime"], INSTANT) }))
    .filter((entry): entry is Event => entry.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** PostNord sends event codes as strings or numbers. */
function eventCode(event: Json): string {
  const code = event["eventCode"];
  return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

function eventStatus(event: Json): ParcelStatus | null {
  // Event codes that say more than the status (delivery in progress, extended retention).
  const code = eventCode(event);
  const byCode = code === "" ? null : ruleStatus(CARRIER_ID, `event:${code}`);
  return byCode ?? statusOf(text(event["status"], STRINGS));
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
    const rawStatus = text(event["eventDescription"], STRINGS) ?? eventCode(event);
    if (rawStatus !== "") {
      entries.push({
        at,
        status,
        rawStatus,
        location: text(asObject(event["location"])["displayName"], STRINGS),
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
    const value = num(weight["value"], DECIMAL);
    const factor = { kg: 1, g: 0.001 }[String(weight["unit"]).toLowerCase()];
    if (value !== null && factor !== undefined && value > 0) {
      return value * factor;
    }
  }
  return null;
}

function pickupPoint(raw: Json, ordered: readonly Event[]): string | null {
  for (const key of ["destinationDeliveryPoint", "deliveryPoint"]) {
    const name = text(asObject(raw[key])["name"], STRINGS);
    if (name !== null) {
      return name;
    }
  }
  const waiting = ordered
    .filter(({ event }) => event["status"] === "AVAILABLE_FOR_DELIVERY")
    .at(-1);
  return waiting === undefined
    ? null
    : text(asObject(waiting.event["location"])["locationName"], STRINGS);
}

export function shipmentSnapshot(
  raw: Json,
  code: string,
  report: (status: string) => void,
): ParcelSnapshot {
  const ordered = events(raw);
  const statusCode = text(raw["status"], STRINGS);
  let status = statusOf(statusCode);
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
  const shipmentId = text(raw["shipmentId"], STRINGS) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: shipmentId,
    status,
    rawStatus: text(asObject(raw["statusText"])["header"], STRINGS) ?? statusCode,
    delivered,
    deliveredAt: delivered ? (deliveries.at(-1)?.at ?? null) : null,
    plannedFrom: delivered ? null : isoTime(raw["estimatedTimeOfArrival"], INSTANT),
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(raw, ordered),
    url: rulesTrackingUrl(CARRIER_ID, shipmentId),
    sender: text(asObject(raw["consignor"])["name"], STRINGS),
    receiver: text(asObject(raw["consignee"])["name"], STRINGS),
    weightKg: weightKg(raw),
    history: history(ordered),
    raw,
  });
}
