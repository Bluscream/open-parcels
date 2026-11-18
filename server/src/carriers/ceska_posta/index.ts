import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  defineCarrier,
  RateLimitedError,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type PluginLogger,
} from "../../plugin/api.js";
import {
  asArray,
  asObject,
  isObject,
  joinParts,
  num,
  requestJson,
  statusReporter,
  text,
  type Json,
} from "../_kit/json.js";
import { dayWindow } from "../_kit/zoned.js";
import {
  buildHistory,
  deriveStatus,
  lastStatusText,
  normalizeEvents,
  ZONE,
  type CpEvent,
} from "./events.js";

const CARRIER_ID = "ceska_posta";
const HISTORY_HOST = "b2c.cpost.cz";
const PACKAGE_HOST = "www.balikovna.cz";
const PLAUSIBLE = /^[A-Z0-9]{8,30}$/i;
/** Codes per history request, as the endpoint expects. */
const BATCH_SIZE = 10;
const NOT_FOUND = new Set(["-3", "-4"]);

/** One history request for up to ten codes; the answer lists one object per code, in order. */
async function readHistory(http: PluginHttp, codes: readonly string[]): Promise<Map<string, Json>> {
  const url = new URL(`https://${HISTORY_HOST}/services/ParcelHistory/getDataAsJson`);
  url.searchParams.set("idParcel", codes.join(";"));
  url.searchParams.set("language", "en");
  const body = await requestJson(http, url, "Česká pošta history");
  if (!Array.isArray(body)) {
    throw new UnexpectedResponseError("Česká pošta history did not answer with a list.");
  }
  const found = new Map<string, Json>();
  codes.forEach((code, index) => {
    const entry: unknown = body[index];
    if (isObject(entry)) {
      found.set(code, entry);
    }
  });
  return found;
}

/** The Balíkovna page adds sender, pickup place and event times. Optional; a failure is logged. */
async function readPackage(
  http: PluginHttp,
  logger: PluginLogger,
  code: string,
): Promise<Json | null> {
  try {
    const url = new URL(`https://${PACKAGE_HOST}/o/cpb/package/${encodeURIComponent(code)}`);
    url.searchParams.set("lang", "en_US");
    const body = await requestJson(http, url, "Balíkovna package");
    return isObject(body) ? body : null;
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw error;
    }
    logger.debug(
      { error: error instanceof Error ? error.name : "unknown" },
      "Balíkovna lookup failed.",
    );
    return null;
  }
}

/** No events, or only the "no such consignment" sentinel. */
function isNotFound(backbone: Json): boolean {
  const states = asArray(asObject(backbone["states"])["state"]);
  return (
    states.length === 0 ||
    (states.length === 1 && NOT_FOUND.has(text(asObject(states[0])["id"]) ?? ""))
  );
}

function toSnapshot(
  code: string,
  backbone: Json,
  enrichment: Json | null,
  report: (c: string) => void,
): ParcelSnapshot {
  const events: CpEvent[] = normalizeEvents(backbone, enrichment);
  const status = deriveStatus(events, report);
  const delivered = status === "delivered";
  const history = buildHistory(events);
  const attributes = asObject(backbone["attributes"]);
  const extra = asObject(enrichment);
  const place = asObject(extra["pickupPlace"]);
  // The 53 event's day is the delivery day; no time of day is ever given.
  const outDay =
    status === "out_for_delivery" ? (events.findLast((e) => e.id === "53")?.date ?? null) : null;
  const window = dayWindow(outDay, ZONE);
  const sender = text(extra["sender"]);
  const weight = num(attributes["weight"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: lastStatusText(events) ?? text(extra["statusMessage"]),
    delivered,
    deliveredAt: delivered ? (history.find((e) => e.status === "delivered")?.at ?? null) : null,
    plannedFrom: delivered ? null : (window?.from ?? null),
    plannedTo: delivered ? null : (window?.to ?? null),
    pickup: status === "at_pickup_point",
    pickupPoint: joinParts(text(place["name"]), text(place["address"])),
    url: `https://${PACKAGE_HOST}/cs/sledovat-balik/-/balik/${encodeURIComponent(code)}`,
    sender: sender === "-" ? null : sender,
    weightKg: weight === null || weight <= 0 ? null : weight,
    history,
    raw: { backbone, enrichment },
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = statusReporter(context);
  const codes = barcodes.filter((code) => PLAUSIBLE.test(code));
  const snapshots: ParcelSnapshot[] = [];
  for (let start = 0; start < codes.length; start += BATCH_SIZE) {
    const batch = codes.slice(start, start + BATCH_SIZE);
    const found = await readHistory(context.http, batch);
    for (const code of batch) {
      const backbone = found.get(code) ?? null;
      if (backbone === null || isNotFound(backbone)) {
        continue;
      }
      const enrichment = await readPackage(context.http, context.logger, code);
      snapshots.push(toSnapshot(code, backbone, enrichment, report));
    }
  }
  return { snapshots, complete: true };
}

export const ceskaPosta = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Česká pošta",
  countries: ["CZ"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HISTORY_HOST]: { intervalMs: 5_000, burst: 2 },
      [PACKAGE_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
