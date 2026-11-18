import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";

const CARRIER_ID = "helthjem";
const API_HOST = "services.helthjem.no";
const SITE = "https://helthjem.no";
const BARCODE_PATTERN = /^[A-Z0-9-]{6,40}$/i;

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

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;
type Json = Readonly<Record<string, unknown>>;

/**
 * One enum serves the parcel and its events. Provisional: the vocabulary could not be listed, so
 * unknown values are reported rather than guessed. Candidates for the shared rules package.
 */
const STATUS: Readonly<Record<string, ParcelStatus>> = {
  REGISTERED: "registered",
  PRE_TRANSIT: "registered",
  BOOKED: "registered",
  IN_TRANSIT: "in_transit",
  COLLECTED: "in_transit",
  AT_TERMINAL: "in_transit",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERING: "out_for_delivery",
  READY_FOR_PICKUP: "at_pickup_point",
  DELIVERED: "delivered",
  RETURNED: "returning",
  DEVIATION: "problem",
};

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS[code] ?? null);
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
  if (response.status !== 200) {
    throw new TransientError(`Helthjem answered HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = response.json();
  } catch {
    throw new UnexpectedResponseError("Helthjem did not answer with JSON.");
  }
  if (!isObject(body)) {
    throw new UnexpectedResponseError("Helthjem did not answer with an object.");
  }
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
  const list = Array.isArray(raw["events"]) ? raw["events"].filter(isObject) : [];
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
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
    deliveredAt: delivered ? (history.find((e) => e.status === "delivered")?.at ?? null) : null,
    // A single estimated date: a point, never a window.
    plannedFrom: delivered ? null : isoTime(asObject(raw["estimatedDelivery"])["date"]),
    pickup: status === "at_pickup_point",
    pickupPoint: text(servicePoint["name"]),
    url: `${SITE}/sporing/?trackingReference=${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
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
