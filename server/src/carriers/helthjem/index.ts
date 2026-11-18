import { z } from "zod";
import {
  carrierPattern,
  asObject,
  defineCarrier,
  ruleStatus,
  expectStatus,
  isObject,
  isoTime as kitIsoTime,
  newestFirst,
  objects,
  readObject,
  snapshot,
  text as anyText,
  trackEach,
  unknownReporter,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "helthjem";
const API_HOST = "services.helthjem.no";
const SITE = "https://helthjem.no";
const BARCODE_PATTERN = carrierPattern("helthjem");

/** The tracking type returns null for an unknown reference, a clean not-found signal. */
const QUERY = `query ParcelTracking($ref: String!) {
  getParcelTrackingDetails(parcelReference: $ref) {
    trackingNumber
    status
    estimatedDelivery { date }
    servicePoint { name address }
    deliveryPoint { type }
    events { createdAt status location message { description } }
  }
}`;

const text = (value: unknown): string | null => anyText(value, { numbers: false });
const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "runtime", epoch: "ms" });

/**
 * One enum serves the parcel and its events (the shared table). Provisional: the vocabulary
 * could not be listed, so unknown values are reported rather than guessed.
 */
function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${API_HOST}/graphql`), {
    method: "POST",
    body: JSON.stringify({ query: QUERY, variables: { ref: barcode } }),
    // The backend checks that requests come from the consumer site.
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: SITE,
      referer: `${SITE}/sporing/`,
    },
  });
  expectStatus(response, "Helthjem", 200);
  const body = readObject(response, "Helthjem");
  if (Array.isArray(body["errors"]) && body["errors"].length > 0) {
    throw new UnexpectedResponseError("Helthjem answered with GraphQL errors.");
  }
  if (!isObject(body["data"])) {
    throw new UnexpectedResponseError("Helthjem answered without data.");
  }
  const parcel = body["data"]["getParcelTrackingDetails"];
  if (parcel === null || parcel === undefined) {
    return null;
  }
  if (!isObject(parcel)) {
    throw new UnexpectedResponseError("Helthjem answered with a parcel that is not an object.");
  }
  return parcel;
}

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const code = text(raw["status"]);
  const unmapped = new Set<string>();
  if (code !== null && mapCode(code) === null) {
    unmapped.add(code);
  }
  const history: SnapshotEvent[] = [];
  const list = objects(raw["events"]);
  for (const event of list) {
    const at = isoTime(event["createdAt"]);
    const eventCode = text(event["status"]);
    if (eventCode !== null && mapCode(eventCode) === null) {
      unmapped.add(eventCode);
    }
    const rawStatus = text(asObject(event["message"])["description"]) ?? eventCode;
    if (at !== null && rawStatus !== null) {
      history.push({
        at,
        rawStatus,
        status: mapCode(eventCode),
        location: text(event["location"]),
      });
    }
  }
  unmapped.forEach(report);
  const sorted = newestFirst(history);
  const status = mapCode(code);
  const delivered = status === "delivered";
  const servicePoint = asObject(raw["servicePoint"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: code,
    delivered,
    // No top-level delivery time: the newest delivered event carries it.
    deliveredAt: delivered ? (sorted.find((e) => e.status === "delivered")?.at ?? null) : null,
    // A single estimated date: a point, never a window.
    plannedFrom: delivered ? null : isoTime(asObject(raw["estimatedDelivery"])["date"]),
    pickup: status === "at_pickup_point",
    pickupPoint: text(servicePoint["name"]),
    url: `${SITE}/sporing/?trackingReference=${encodeURIComponent(barcode)}`,
    history: sorted,
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, BARCODE_PATTERN, async (barcode) => {
    const raw = await lookUp(context.http, barcode);
    return raw === null ? null : toSnapshot(raw, barcode, report);
  });
}

export const helthjem = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Helthjem",
  countries: ["NO"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
