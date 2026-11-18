import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type PluginHttp,
  asObject,
  isObject,
  num,
  objects,
  readJson,
  text,
  type Json,
  epoch,
  isoTime,
  newestFirst,
  expectStatus,
  ruleStatus,
  rulesStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
} from "../../plugin/api.js";

const CARRIER_ID = "fan_courier";
const HOST = "www.fancourier.ro";
const ZONE = "Europe/Bucharest";
const DELIVERED_CODE = "S2";

/** Event names that mean the parcel waits in a locker, whatever the code says (shared table). */
const mentionsLocker = (name: string): boolean =>
  rulesStatus(CARRIER_ID, { text: name, fields: { use: "locker" } }) !== null;

const PLAUSIBLE = carrierPattern("fan_courier");

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/limit-tracking.php`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ action: "get_awb", awb: code, lang: "romana" }),
  });
  expectStatus(response, "FAN Courier tracking");
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
    const at = isoTime(event["date"], { naive: { zone: ZONE }, epoch: "auto", epochStrings: true });
    const code = text(event["id"]);
    const rawStatus = text(event["name"]) ?? code;
    if (at !== null && rawStatus !== null) {
      result.push({
        at,
        rawStatus,
        status: ruleStatus(CARRIER_ID, code),
        location: text(event["location"]),
      });
    }
  }
  return newestFirst(result);
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const events = objects(raw["events"]);
  const entries = history(events);
  const when = (event: Json): number =>
    epoch(isoTime(event["date"], { naive: { zone: ZONE }, epoch: "auto", epochStrings: true }));
  const newestRaw = [...events].sort((a, b) => when(b) - when(a))[0] ?? {};
  const code = text(newestRaw["id"]);
  let status: ParcelStatus | null = ruleStatus(CARRIER_ID, code);
  if (code !== null && status === null) {
    report(code);
  }
  const name = text(newestRaw["name"])?.toLowerCase() ?? "";
  if (status !== "delivered" && mentionsLocker(name)) {
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
    deliveredAt:
      deliveredEvent === undefined
        ? null
        : isoTime(deliveredEvent["date"], {
            naive: { zone: ZONE },
            epoch: "auto",
            epochStrings: true,
          }),
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
