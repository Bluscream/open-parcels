import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  asArray,
  asObject,
  defineCarrier,
  isoTime,
  isTimeZone,
  newestFirst,
  readJsonObject,
  snapshot,
  text,
  trackEach,
  TransientError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
  type StatusTable,
} from "../../plugin/api.js";

const CARRIER_ID = "better_trucks";
const HOST = "tracking.bettertrucks.com";
const PLAUSIBLE = /^[A-Z0-9_-]{6,40}$/i;
/** Its times carry no offset; the one confirmed capture read correctly as UTC. */
const DEFAULT_ZONE = "UTC";

export const BETTER_TRUCKS_STATUS: StatusTable = {
  SHIPMENT_CREATED: "registered",
  TRANSACTION_CREATED: "registered",
  INJECTED: "in_transit",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
};
/** `SCANNED_AT_HUB_<facility>`: the suffix names a hub, not a state. */
const HUB_SCAN = "SCANNED_AT_HUB";

function stage(code: string | null): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  return BETTER_TRUCKS_STATUS[code] ?? (code.startsWith(HUB_SCAN) ? "in_transit" : null);
}

/** The endpoint answers 200 for everything; an unknown number says UNKNOWN with no history. */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/api/tracking/${encodeURIComponent(barcode)}`);
  url.searchParams.set("isFromExternalTracking", "true");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`Better Trucks tracking answered HTTP ${response.status}.`);
  }
  const payload = readJsonObject(response, "Better Trucks tracking");
  const status = text(asObject(payload["tracking_status"])["status"]);
  return status === "UNKNOWN" || asArray(payload["tracking_history"]).length === 0 ? null : payload;
}

export function betterTrucksSnapshot(
  raw: Json,
  barcode: string,
  zone: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const current = asObject(raw["tracking_status"]);
  const code = text(current["status"]);
  const status = stage(code);
  const history: SnapshotEvent[] = [];
  const unmapped = new Set<string>();
  for (const entry of asArray(raw["tracking_history"])) {
    const event = asObject(entry);
    const eventCode = text(event["status"]);
    const at = isoTime(event["object_created"], zone);
    if (eventCode !== null && stage(eventCode) === null) {
      unmapped.add(eventCode);
    }
    if (at !== null && eventCode !== null) {
      history.push({ at, rawStatus: eventCode, status: stage(eventCode), location: null });
    }
  }
  if (code !== null && status === null) {
    unmapped.add(code);
  }
  unmapped.forEach(report);
  const delivered = status === "delivered";
  const resolved = text(raw["tracking_number"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: resolved,
    status,
    rawStatus: code,
    delivered,
    deliveredAt: delivered ? isoTime(current["object_created"], zone) : null,
    // A point estimate; once delivered it is rewritten to the delivery time, so it is dropped.
    plannedFrom: delivered ? null : isoTime(raw["eta"], zone),
    url: `https://${HOST}/track/${encodeURIComponent(resolved)}`,
    history: newestFirst(history),
    raw,
  });
}

const configSchema = z.looseObject({
  timeZone: z
    .string()
    .refine(isTimeZone, "Not a known time zone.")
    .optional()
    .describe("Time zone Better Trucks' offset-less times are read in. Defaults to UTC."),
});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

export const betterTrucks = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Better Trucks",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, barcode);
      return raw === null
        ? null
        : betterTrucksSnapshot(raw, barcode, context.config.timeZone ?? DEFAULT_ZONE, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
