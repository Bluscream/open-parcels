import { z } from "zod";
import {
  asTracked,
  carrierPattern,
  ruleStatus,
  defineCarrier,
  isTimeZone,
  SignInRejectedError,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { isoTime, objects, rulesTrackingUrl, text, type Json } from "../../plugin/api.js";
import { API_HOST, UspsClient } from "./client.js";
import { fetchInformed, INFORMED_API_HOST } from "./informed.js";
import { informedSignIn } from "./journey.js";

/** Offset-less timestamps keep the runtime's own reading, as before; numbers are epoch ms. */
const RUNTIME_TIME = { naive: "runtime", epoch: "ms" } as const;

const CARRIER_ID = "usps";

type Status = NonNullable<ParcelSnapshot["status"]>;

/**
 * A `statusCategory` / `status` / `eventType` text, by the shared table's prefixes (checked in
 * order).
 */
export function mapUsps(value: string | null): Status | null {
  if (value === null) {
    return null;
  }
  const folded = value.trim().toLowerCase();
  return ruleStatus(CARRIER_ID, folded);
}

const BARCODE_PATTERN = carrierPattern("usps");

const configSchema = z.looseObject({
  /** Where the Informed Delivery addresses are; their package times carry no zone. */
  timeZone: z.string().refine(isTimeZone, "Not a known time zone.").optional(),
});
type Config = z.infer<typeof configSchema>;
/**
 * A tracking source keeps a consumer key pair from the USPS developer portal, with the Tracking
 * API enabled; an Informed Delivery account the sign-in chain and its enrolled addresses.
 */
const secretSchema = z.object({
  consumerKey: z.string().min(1).optional(),
  consumerSecret: z.string().min(1).optional(),
  informed: z
    .object({ refreshToken: z.string().min(1), addresses: z.array(z.string().regex(/^\d{11}$/)) })
    .optional(),
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
  const { consumerKey, consumerSecret } = context.secret;
  if (consumerKey === undefined || consumerSecret === undefined) {
    throw new SignInRejectedError("Enter a USPS consumer key pair for tracking.");
  }
  const client = new UspsClient(
    context.http,
    context.session,
    { consumerKey, consumerSecret },
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
      // USPS echoes its own spelling of the number; the tracked code stays the key.
      snapshots.push(asTracked(uspsSnapshot(raw, barcode, report), barcode));
    }
  }
  return { snapshots, complete: true };
}

export const usps = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "USPS",
  countries: ["US"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [informedSignIn<Config>(), { type: "api_key", kinds: ["tracking"] }],
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [INFORMED_API_HOST]: { intervalMs: 6_000, burst: 2 },
      "verified.usps.com": { intervalMs: 3_000, burst: 3 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  async fetchAccount(context) {
    const informed = context.secret.informed;
    if (informed === undefined) {
      throw new SignInRejectedError("Sign in to USPS Informed Delivery first.");
    }
    return fetchInformed(context, { informed }, context.config.timeZone ?? "America/New_York");
  },
});
