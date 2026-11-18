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

const CARRIER_ID = "gobolt";
const API_HOST = "api.secondcloset.com";
const API_PATH = "/logistics/api/v1/bolt_shipping_labels/search";
const BARCODE_PATTERN = /^[A-Z0-9-]{6,40}$/i;

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;
type Json = Readonly<Record<string, unknown>>;

/** Label status names. Candidates for the shared rules package. */
const STATUS: Readonly<Record<string, ParcelStatus>> = {
  label_created: "registered",
  label_scanned: "in_transit",
  label_received_at_destination: "in_transit",
  label_out_for_delivery: "out_for_delivery",
  label_delivered: "delivered",
  label_failed: "problem",
  label_returned_to_warehouse: "returning",
};

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function mapName(name: string | null): ParcelStatus | null {
  return name === null ? null : (STATUS[name] ?? null);
}

/** Null when the carrier answers 404 "Tracking number not found"; any other 404 is unexpected. */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${API_HOST}${API_PATH}`);
  url.searchParams.set("tracking_number", barcode);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200 && response.status !== 404) {
    throw new TransientError(`GoBolt answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("GoBolt did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("GoBolt did not answer with an object.");
  }
  if (response.status === 404) {
    if (text(payload["message"])?.toLowerCase() === "tracking number not found") {
      return null;
    }
    throw new UnexpectedResponseError("GoBolt answered 404 without the not-found message.");
  }
  if (text(payload["tracking_number"]) === null) {
    throw new UnexpectedResponseError("GoBolt answered without a tracking number.");
  }
  return payload;
}

function steps(raw: Json): Json[] {
  const list = raw["transit_steps"];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const labelStatus = text(raw["label_status"]);
  const unmapped = new Set<string>();
  const history: SnapshotEvent[] = [];
  for (const step of steps(raw)) {
    const name = text(step["name"]);
    const at = isoTime(step["created_at"]);
    if (name !== null && mapName(name) === null) {
      unmapped.add(name);
    }
    if (name !== null && at !== null) {
      // The description and location can name a place; only the status name is kept.
      history.push({ at, rawStatus: name, status: mapName(name), location: null });
    }
  }
  if (labelStatus !== null && mapName(labelStatus) === null) {
    unmapped.add(labelStatus);
  }
  unmapped.forEach(report);
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // An unmapped current status falls back to the newest step that maps.
  const status =
    mapName(labelStatus) ??
    (labelStatus === null ? null : (history.find((e) => e.status !== null)?.status ?? null));
  const delivered = status === "delivered";
  const deliveryStep = steps(raw).find((s) => s["name"] === "label_delivered");
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: labelStatus,
    delivered,
    deliveredAt: delivered
      ? (isoTime(raw["label_delivered_at"]) ?? isoTime(deliveryStep?.["created_at"]))
      : null,
    // A day-level estimate given as an instant: a point, never a window.
    plannedFrom: delivered ? null : isoTime(raw["estimated_delivery_date"]),
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

export const gobolt = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "GoBolt",
  countries: ["CA"],
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
