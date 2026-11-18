import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import {
  asObject,
  isObject,
  num,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/kit/json.js";
import { epoch, isoTime, newestFirst } from "../../plugin/kit/time.js";
import {
  expectOk,
  lookUpStatus,
  trackEach,
  unknownReporter,
  type Status,
  type StatusTable,
} from "../../plugin/kit/track.js";

const CARRIER_ID = "fan_courier";
const HOST = "www.fancourier.ro";
const ZONE = "Europe/Bucharest";
const DELIVERED_CODE = "S2";

const CODES: StatusTable = {
  C0: "registered",
  ...Object.fromEntries(
    ["H0", "H1", "H2", "H3", "H4", "H10", "H11", "H12", "H13", "H15", "H17", "S35", "S47"].map(
      (code) => [code, "in_transit"],
    ),
  ),
  C1: "out_for_delivery",
  S1: "out_for_delivery",
  S2: "delivered",
  ...Object.fromEntries(
    [
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
      "S10",
      "S14",
      "S15",
      "S19",
      "S20",
      "S21",
      "S22",
      "S24",
      "S25",
      "S27",
      "S28",
      "S30",
      "S37",
      "S42",
      "S50",
    ].map((code) => [code, "problem"]),
  ),
  S43: "returning",
  S46: "at_pickup_point",
};

/** Event names that mean the parcel waits in a locker, whatever the code says. */
const LOCKER_WORDS = [
  "fanbox",
  "easybox",
  "locker",
  "automat de colete",
  "disponibil pentru ridicare",
];

const PLAUSIBLE = /^\d{8,20}$/;

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/limit-tracking.php`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ action: "get_awb", awb: code, lang: "romana" }),
  });
  expectOk(response, "FAN Courier tracking");
  let payload = readJson(response, "FAN Courier tracking");
  if (Array.isArray(payload)) {
    if (payload.length > 1 || (payload.length === 1 && !isObject(payload[0]))) {
      throw new UnexpectedResponseError("FAN Courier answered with an unexpected list.");
    }
    payload = payload[0];
  }
  if (payload === undefined || payload === null || payload === false || payload === "") {
    return null;
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("FAN Courier answered with something that is not a parcel.");
  }
  // Unknown and malformed numbers come back as an error or a bare message.
  if (payload["error"] || ("message" in payload && !("events" in payload))) {
    return null;
  }
  if (!Array.isArray(payload["events"])) {
    throw new UnexpectedResponseError("FAN Courier's answer has no events.");
  }
  return payload;
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["date"], ZONE);
    const code = text(event["id"]);
    const rawStatus = text(event["name"]) ?? code;
    if (at !== null && rawStatus !== null) {
      result.push({
        at,
        rawStatus,
        status: lookUpStatus(CODES, code),
        location: text(event["location"]),
      });
    }
  }
  return newestFirst(result);
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const events = objects(raw["events"]);
  const entries = history(events);
  const when = (event: Json): number => epoch(isoTime(event["date"], ZONE));
  const newestRaw = [...events].sort((a, b) => when(b) - when(a))[0] ?? {};
  const code = text(newestRaw["id"]);
  let status: Status | null = lookUpStatus(CODES, code);
  if (code !== null && status === null) {
    report(code);
  }
  const name = text(newestRaw["name"])?.toLowerCase() ?? "";
  if (status !== "delivered" && LOCKER_WORDS.some((word) => name.includes(word))) {
    status = "at_pickup_point";
  }
  const deliveredEvent = events.find((event) => text(event["id"]) === DELIVERED_CODE);
  if (deliveredEvent !== undefined) {
    status = "delivered";
  } else if (text(raw["returnAwbNumber"]) !== null) {
    status = "returning";
  }
  const weight = num(raw["weight"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(newestRaw["name"]) ?? code,
    deliveredAt: deliveredEvent === undefined ? null : isoTime(deliveredEvent["date"], ZONE),
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? text(newestRaw["location"]) : null,
    url: `https://${HOST}/awb-tracking/?tracking=${encodeURIComponent(barcode)}`,
    receiver: text(asObject(raw["confirmation"])["name"]),
    weightKg: weight !== null && weight > 0 ? weight : null,
    history: entries,
    raw,
  });
}

async function track(context: PluginContext<unknown, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** FAN Courier (Romania): the public AWB tracking. */
export const fanCourier = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "FAN Courier",
  countries: ["RO"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
