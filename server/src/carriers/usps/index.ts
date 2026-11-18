import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { isoTime, objects, rulesTrackingUrl, text, type Json } from "../../plugin/api.js";
import { API_HOST, UspsClient } from "./client.js";

/** Offset-less timestamps keep the runtime's own reading, as before; numbers are epoch ms. */
const RUNTIME_TIME = { naive: "runtime", epoch: "ms" } as const;

const CARRIER_ID = "usps";

type Status = NonNullable<ParcelSnapshot["status"]>;

/**
 * Prefixes of the `statusCategory` / `status` / `eventType` texts, checked in order. Belongs in
 * the shared rules once a USPS table exists there.
 */
const PREFIXES: readonly (readonly [string, Status])[] = [
  ["pre-shipment", "registered"],
  ["shipping label created", "registered"],
  ["label created", "registered"],
  ["accepted", "in_transit"],
  ["usps in possession", "in_transit"],
  ["in transit", "in_transit"],
  ["arrived", "in_transit"],
  ["departed", "in_transit"],
  ["processed", "in_transit"],
  ["preparing for delivery", "in_transit"],
  ["out for delivery", "out_for_delivery"],
  ["available for pickup", "at_pickup_point"],
  ["ready for pickup", "at_pickup_point"],
  ["held at post office", "at_pickup_point"],
  ["delivered", "delivered"],
  ["return to sender", "returning"],
  ["returning", "returning"],
  ["alert", "problem"],
  ["delivery exception", "problem"],
  ["undeliverable", "problem"],
  ["forwarded", "problem"],
];

export function mapUsps(value: string | null): Status | null {
  if (value === null) {
    return null;
  }
  const folded = value.trim().toLowerCase();
  return PREFIXES.find(([prefix]) => folded.startsWith(prefix))?.[1] ?? null;
}

const BARCODE_PATTERN = /^[A-Z0-9]{10,40}$/i;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
/** A consumer key pair from the USPS developer portal, with the Tracking API enabled. */
const secretSchema = z.object({
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
});
type Secret = z.infer<typeof secretSchema>;

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const event of objects(raw["trackingEvents"])) {
    const at = isoTime(event["eventTimestamp"], RUNTIME_TIME);
    const kind = text(event["eventType"]) ?? text(event["statusCategory"]);
    const rawStatus = text(event["eventCode"]) ?? kind;
    if (at !== null && rawStatus !== null) {
      events.push({ at, status: mapUsps(kind), rawStatus, location: null });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function uspsSnapshot(
  raw: Json,
  barcode: string,
  report: (value: string) => void,
): ParcelSnapshot {
  const category = text(raw["statusCategory"]) ?? text(raw["status"]);
  const status = mapUsps(category);
  if (category !== null && status === null) {
    report(category);
  }
  const events = history(raw);
  const delivered = status === "delivered";
  const code = text(raw["trackingNumber"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: text(raw["status"]) ?? category,
    delivered,
    deliveredAt: delivered
      ? (events.find((event) => event.status === "delivered")?.at ?? null)
      : null,
    pickup: status === "at_pickup_point",
    url:
      rulesTrackingUrl(CARRIER_ID, code) ??
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(code)}`,
    history: events,
    raw,
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const client = new UspsClient(
    context.http,
    context.session,
    context.secret,
    () => context.clock.now().getTime(),
    context.logger,
  );
  const snapshots: ParcelSnapshot[] = [];
  const report = (value: string): void => {
    context.reportUnknown("status_category", value);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await client.parcel(barcode);
    if (raw !== null) {
      snapshots.push(uspsSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const usps = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "USPS",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "api_key" },
  http: {
    limits: { [API_HOST]: { intervalMs: 4_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
