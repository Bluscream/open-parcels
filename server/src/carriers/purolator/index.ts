import { z } from "zod";
import {
  asArray as asList,
  asObject,
  CaptchaError,
  carrierKey,
  carrierPattern,
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  num,
  parseJsonBody,
  ruleStatus,
  rulesTrackingUrl,
  snapshot,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "purolator";
export const HOST = "public-tracking.purolator.com";
const PLAUSIBLE = carrierPattern(CARRIER_ID);
const LB_TO_KG = 0.45359237;
const HISTORY_LIMIT = 20;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;

/** Events carry local wall time; the scan's province says which zone. */
const PROVINCE_ZONES: Readonly<Record<string, string>> = {
  NL: "America/St_Johns",
  NS: "America/Halifax",
  NB: "America/Halifax",
  PE: "America/Halifax",
  QC: "America/Toronto",
  ON: "America/Toronto",
  MB: "America/Winnipeg",
  SK: "America/Regina",
  AB: "America/Edmonton",
  BC: "America/Vancouver",
  YT: "America/Whitehorse",
  NT: "America/Yellowknife",
  NU: "America/Iqaluit",
};
const DEFAULT_ZONE = "America/Toronto";

function zoneOf(event: Json): string | null {
  const province = text(asObject(event["location"])["provinceState"])?.toUpperCase();
  return province === undefined ? null : (PROVINCE_ZONES[province] ?? null);
}

const localTime = (value: unknown, zone: string): string | null =>
  isoTime(value, { naive: { zone } });

/**
 * One POST per code. A bot challenge or a refusal stops the run (the challenge is never
 * answered); the carrier's own NOT FOUND is a normal absence.
 */
export async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/tracking/data`), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": carrierKey(CARRIER_ID, "website_key"),
    },
    body: JSON.stringify({
      search: [{ trackingId: code, sequenceId: 1, eventSortOrder: "d" }],
      language: "en",
    }),
  });
  const waf = (response.headers.get("x-amzn-waf-action") ?? "").toLowerCase();
  if ((response.status === 202 || response.status === 405) && /captcha|challenge/.test(waf)) {
    throw new CaptchaError("Purolator's edge put a bot challenge in front of the lookup.");
  }
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Purolator answered HTTP ${response.status}.`);
  }
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("Purolator answered without a JSON object.");
  }
  const searchStatus = text(asObject(asList(payload["searchResult"])[0])["status"]);
  if (searchStatus === "NOT FOUND") {
    return null;
  }
  if (searchStatus !== "FOUND") {
    throw new UnexpectedResponseError("Purolator answered an unexpected search result.");
  }
  return asList(payload["shipment"]).length === 0 ? null : payload;
}

function pick(list: unknown, index: unknown): Json {
  const at = typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0;
  return asObject(asList(list)[at]);
}

function weightKg(shipment: Json): number | null {
  const weight = asObject(asObject(shipment["details"])["weight"]);
  const value = num(weight["value"], { strings: false });
  if (shipment["pieceTotalCount"] !== 1 || weight["unit"] !== "LB" || value === null) {
    return null;
  }
  return Math.round(value * LB_TO_KG * 1000) / 1000;
}

export function toSnapshot(raw: Json, code: string, report: (key: string) => void): ParcelSnapshot {
  const result = asObject(asList(raw["searchResult"])[0]);
  const shipment = pick(raw["shipment"], result["shipmentIndex"]);
  const pkg = pick(shipment["package"], result["packageIndex"]);
  const events = asList(pkg["events"]).filter(isObject);
  const last = events[0] ?? asObject(pkg["lastEvent"]);
  const fallbackZone = events.map(zoneOf).find((zone) => zone !== null) ?? DEFAULT_ZONE;
  const zone = zoneOf(last) ?? fallbackZone;
  const delivered =
    text(asObject(pkg["status"])["code"]) === "DEL" ||
    text(asObject(shipment["status"])["code"]) === "DEL";
  const eventCode = text(last["code"]);
  const status = delivered ? "delivered" : ruleStatus(CARRIER_ID, eventCode, report);
  const history: SnapshotEvent[] = newestFirst(
    events.flatMap((event) => {
      const at = localTime(event["dateTime"], zoneOf(event) ?? fallbackZone);
      const rawStatus = text(event["description"]) ?? text(event["code"]);
      return at === null || rawStatus === null
        ? []
        : [{ at, rawStatus, status: ruleStatus(CARRIER_ID, text(event["code"])), location: null }];
    }),
  ).slice(0, HISTORY_LIMIT);
  const barcode = text(raw["trackingNumber"]) ?? text(pkg["pin"]) ?? code;
  const deliveryAt = asObject(asObject(pkg["details"])["deliveryDetails"])["deliveryDateTime"];
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus:
      text(last["description"]) ?? text(asObject(pkg["status"])["description"]) ?? eventCode,
    delivered,
    deliveredAt: delivered ? localTime(deliveryAt ?? last["dateTime"], zone) : null,
    plannedFrom: delivered ? null : localTime(pkg["estimatedDeliveryDate"], zone),
    pickup: status === "at_pickup_point",
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    weightKg: weightKg(shipment),
    history,
    raw,
  });
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, code, report);
  });
}

/** Purolator (Canada): the public tracking website's lookup, by tracking number. */
export const purolator = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Purolator",
  countries: ["CA"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema: z.null(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 10_000, burst: 1 }, "*": { intervalMs: 10_000, burst: 1 } },
    userAgent: {
      value: carrierKey(CARRIER_ID, "browser_user_agent"),
      reason: "Purolator's CDN refuses requests that do not carry a browser User-Agent.",
    },
  },
  track,
});
