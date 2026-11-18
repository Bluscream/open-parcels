import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type FetchResult,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { isObject, num, readObject, text, type Json } from "../../plugin/kit/json.js";
import { isoTime, localDay, newestFirst } from "../../plugin/kit/time.js";
import {
  expectOk,
  lookUpStatus,
  unknownReporter,
  type StatusTable,
} from "../../plugin/kit/track.js";

const CARRIER_ID = "econt";
const HOST = "ee.econt.com";
const ZONE = "Europe/Sofia";
/** Codes per request; Econt answers a batch in one go, but a small batch keeps a failure small. */
const BATCH = 10;

/** The headline status, in English where Econt translates it. */
const STATUSES: StatusTable = {
  Delivered: "delivered",
  "Arrival-Departure from HUB": "in_transit",
  "Анулирана преди изпращане": "problem",
  "Awaiting delivery to Econt": "registered",
  "In delivery office": "in_transit",
};

/** History entries name where the parcel went. */
const DESTINATIONS: StatusTable = {
  client: "delivered",
  prepared: "registered",
  canceled: "problem",
  office: "in_transit",
  courier_direction: "in_transit",
  courier: "in_transit",
  in_delivery_office: "in_transit",
  arrival_departure_from_hub: "in_transit",
  in_delivery_courier: "out_for_delivery",
  return: "returning",
  is_returning_to_sender: "returning",
  returned_to_sender: "returning",
  destroy: "problem",
  failed_delivery: "problem",
};

const PLAUSIBLE = /^\d{6,20}$/;

/**
 * One batch lookup. Every answer must name a requested code exactly once; an error element
 * stands for the single code no other element named. Anything else stops the run.
 */
async function lookUpBatch(http: PluginHttp, codes: readonly string[]): Promise<Map<string, Json>> {
  const response = await http.request(
    new URL(`https://${HOST}/services/Shipments/ShipmentService.getShipmentStatuses.json`),
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ shipmentNumbers: codes }),
    },
  );
  expectOk(response, "Econt tracking");
  const statuses = readObject(response, "Econt tracking")["shipmentStatuses"];
  if (!Array.isArray(statuses)) {
    throw new UnexpectedResponseError("Econt's answer has no shipment list.");
  }
  const found = new Map<string, Json>();
  let errors = 0;
  for (const item of statuses) {
    const status = isObject(item) ? item["status"] : undefined;
    if (isObject(status)) {
      const number = text(status["shipmentNumber"]);
      if (number === null || !codes.includes(number) || found.has(number)) {
        throw new UnexpectedResponseError("Econt answered for a shipment that was not asked for.");
      }
      found.set(number, status);
    } else if (isObject(item) && item["error"] !== undefined && item["error"] !== null) {
      errors += 1;
    } else {
      throw new UnexpectedResponseError("Econt's shipment list holds something unexpected.");
    }
  }
  if (found.size + errors !== codes.length) {
    throw new UnexpectedResponseError("Econt's answer does not match the codes asked for.");
  }
  return found;
}

function history(raw: Json, report: (key: string) => void): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const event of Array.isArray(raw["trackingEvents"]) ? raw["trackingEvents"] : []) {
    if (!isObject(event)) {
      continue;
    }
    const at = isoTime(event["time"], ZONE);
    const type = text(event["destinationType"]);
    const rawStatus =
      text(event["destinationDetailsEn"]) ?? text(event["destinationDetails"]) ?? type;
    const status = lookUpStatus(DESTINATIONS, type);
    if (type !== null && status === null) {
      report(`destination:${type}`);
    }
    if (at !== null && rawStatus !== null) {
      events.push({ at, rawStatus, status, location: null });
    }
  }
  return newestFirst(events);
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const rawStatus = text(raw["shortDeliveryStatusEn"]) ?? text(raw["shortDeliveryStatus"]);
  const deliveredAt = isoTime(raw["deliveryTime"], ZONE);
  const delivered = deliveredAt !== null || rawStatus === "Delivered";
  const mapped = delivered ? "delivered" : lookUpStatus(STATUSES, rawStatus);
  if (rawStatus !== null && mapped === null) {
    report(rawStatus);
  }
  const expected = isoTime(raw["expectedDeliveryDate"], ZONE);
  // Econt gives a delivery day, not a time: the window is that whole day in Bulgaria.
  const day = delivered || expected === null ? null : localDay(expected, ZONE);
  const weight = num(raw["weight"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status: mapped,
    rawStatus,
    delivered,
    deliveredAt,
    plannedFrom: day?.from ?? null,
    plannedTo: day?.to ?? null,
    url: `https://${HOST}/load_direct.php?target=EeActivityTraceParcell&shipment_num=${encodeURIComponent(barcode)}`,
    weightKg: weight !== null && weight > 0 ? weight : null,
    history: history(raw, report),
    raw,
  });
}

async function track(
  context: PluginContext<unknown, unknown>,
  barcodes: readonly string[],
): Promise<FetchResult> {
  const report = unknownReporter(context, "status");
  const tracked = new Map<string, string>();
  for (const barcode of barcodes) {
    const code = barcode.trim();
    if (PLAUSIBLE.test(code) && !tracked.has(code)) {
      tracked.set(code, barcode);
    }
  }
  const codes = [...tracked.keys()];
  const snapshots: ParcelSnapshot[] = [];
  for (let start = 0; start < codes.length; start += BATCH) {
    const found = await lookUpBatch(context.http, codes.slice(start, start + BATCH));
    for (const [code, raw] of found) {
      snapshots.push(toSnapshot(raw, tracked.get(code) ?? code, report));
    }
  }
  return { snapshots, complete: true };
}

/** Econt (Bulgaria): the public shipment status service, several codes per request. */
export const econt = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "Econt",
  countries: ["BG"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
