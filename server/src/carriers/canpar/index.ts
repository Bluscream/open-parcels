import { z } from "zod";
import {
  carrierPattern,
  asArray,
  asObject,
  dayWindow,
  defineCarrier,
  isObject,
  joinParts,
  newestFirst,
  parseLocal,
  requestJson,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  UnexpectedResponseError,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "canpar";
const HOST = "canship.canpar.com";
const PLAUSIBLE = carrierPattern("canpar");
/**
 * Canpar's event clock has no offset, and the `time_shift` field is not one either. Eastern time
 * is the network's home zone; western events may be off by a few hours.
 */
const ZONE = "America/Toronto";

/** Only status and timing keys are kept; the payload carries addresses and signatures. */
function safeRaw(raw: Json): Json {
  const keep = [
    "status",
    "status_description_en",
    "delivered",
    "shipping_date",
    "estimated_delivery_date",
  ];
  const events = asArray(raw["events"]).map((entry) => {
    const event = asObject(entry);
    return {
      code: event["code"],
      code_description_en: event["code_description_en"],
      local_date_time: event["local_date_time"],
    };
  });
  return {
    ...Object.fromEntries(keep.filter((key) => key in raw).map((key) => [key, raw[key]])),
    events,
  };
}

export async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const body = await requestJson(
    http,
    new URL(`https://${HOST}/api/CanparAddons/trackByBarcodeV2`),
    "Canpar tracking",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ barcode: code, track_shipment: true }),
    },
  );
  if (!isObject(body) || (body["error"] !== null && body["error"] !== undefined)) {
    throw new UnexpectedResponseError("Canpar tracking refused the lookup.");
  }
  const result = asArray(body["result"]);
  if (Array.isArray(body["result"]) && result.length === 0) {
    return null;
  }
  const [parcel] = result;
  if (result.length !== 1 || !isObject(parcel)) {
    throw new UnexpectedResponseError("Canpar tracking answered with an unexpected envelope.");
  }
  return parcel;
}

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asArray(raw["events"])) {
    const event = asObject(entry);
    const at = parseLocal(event["local_date_time"], ZONE);
    const code = text(event["code"]);
    const rawStatus = text(event["code_description_en"]) ?? code;
    if (at !== null && rawStatus !== null) {
      events.push({ at, rawStatus, status: ruleStatus(CARRIER_ID, code), location: null });
    }
  }
  return newestFirst(events);
}

export function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  // Events arrive newest first.
  const newest = asObject(asArray(raw["events"])[0]);
  const eventCode = text(newest["code"]);
  // The event code; the summary number only when there are no events yet.
  const summary = text(raw["status"]);
  const status =
    eventCode !== null
      ? ruleStatus(CARRIER_ID, eventCode, report)
      : ruleStatus(CARRIER_ID, summary === null ? null : `summary:${summary}`, report);
  // Delivered only when the flag and the newest event agree.
  const delivered = raw["delivered"] === true && status === "delivered";
  const address = asObject(newest["address"]);
  const window =
    delivered || status === "returning"
      ? null
      : dayWindow(text(raw["estimated_delivery_date"]), ZONE);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["barcode"]) ?? code,
    status,
    rawStatus:
      text(newest["code_description_en"]) ?? eventCode ?? text(raw["status_description_en"]),
    delivered,
    deliveredAt: delivered ? parseLocal(newest["local_date_time"], ZONE) : null,
    plannedFrom: window?.from ?? null,
    plannedTo: window?.to ?? null,
    pickup: status === "at_pickup_point",
    pickupPoint:
      status === "at_pickup_point"
        ? joinParts(text(address["city"]), text(address["province"]))
        : null,
    // The carrier's own links are plain HTTP; the public page takes the code in a form.
    url: "https://www.canpar.com/en/track/",
    history: history(raw),
    raw: safeRaw(raw),
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, PLAUSIBLE, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, code, report);
  });
}

export const canpar = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Canpar Express",
  countries: ["CA"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
