import { z } from "zod";
import {
  type PluginHttp,
  asArray,
  defineCarrier,
  epochIso,
  isObject,
  newestFirst,
  readObject,
  SignInRejectedError,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
  type StatusTable,
} from "../../plugin/api.js";

const CARRIER_ID = "airmee";
const HOST = "api.airmee.com";
const ORIGIN = "https://tracking.airmee.com";
/** The tracked "code" is the opaque token from the recipient's tracking link. */
const PLAUSIBLE = /^[A-Za-z0-9_-]{6,120}$/;

/** The courier status enum each timeline event carries. Read from the app's own list. */
export const AIRMEE_STATUS: StatusTable = {
  REGISTERED: "registered",
  WAITING: "registered",
  UNASSIGNED: "registered",
  SCAN: "registered",
  ASSIGNED: "in_transit",
  ON_WAY_TO_PICKUP: "in_transit",
  PICKUP_CONFIRMED: "in_transit",
  ON_WAY_TO_DROPOFF: "out_for_delivery",
  READY_FOR_CUSTOMER_PICKUP: "at_pickup_point",
  DROPOFF_CONFIRMED: "delivered",
  POST_DROPOFF_CONFIRMED: "delivered",
  POSTPONED_UNREACHABLE_CUSTOMER: "problem",
  POSTPONED_OTHER: "problem",
  CANCELLED: "problem",
};

/** Used only when the enum is missing and the tracker sends its display text instead. */
const FORMATTED_STATUS: StatusTable = {
  delivered: "delivered",
  "out for delivery": "out_for_delivery",
  "picked up": "in_transit",
  unassigned: "registered",
  scanned: "registered",
  failed: "problem",
  returned: "returning",
};

/** `EDIT` records that the order was amended: a known value, but not a stage. */
const NOT_A_STAGE = "EDIT";

/** The stage a value names; undefined for `EDIT` and for values we cannot map. */
function stageOf(value: string): ParcelStatus | undefined {
  if (value.toUpperCase() === NOT_A_STAGE) {
    return undefined;
  }
  return AIRMEE_STATUS[value.toUpperCase()] ?? FORMATTED_STATUS[value.toLowerCase()];
}

async function lookUp(http: PluginHttp, hash: string, token: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/track/track_by_url`);
  url.searchParams.set("tracking_url", token);
  url.searchParams.set("phone_number_hash", hash);
  const response = await http.request(url, {
    headers: { accept: "application/json", origin: ORIGIN, referer: `${ORIGIN}/` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("Airmee refused the phone number hash.");
  }
  if (response.status !== 200) {
    throw new TransientError(`Airmee tracking answered HTTP ${response.status}.`);
  }
  const orders: unknown = readObject(response, "Airmee tracking")["order_details"];
  if (!Array.isArray(orders)) {
    throw new UnexpectedResponseError("Airmee tracking answered without an order list.");
  }
  // An unknown token, a wrong hash and an expired tracker all look like this.
  const order = asArray(orders)[0];
  if (order === undefined) {
    return null;
  }
  if (!isObject(order)) {
    throw new UnexpectedResponseError("Airmee tracking listed something that is not an order.");
  }
  return order;
}

function timeline(raw: Json): Json[] {
  return asArray(raw["new_timeline"]).filter(isObject);
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = epochIso(event["time_of_event"], "s", { plausible: true });
    const code = text(event["courier_status"]);
    if (at === null || code === null) {
      continue;
    }
    result.push({ at, rawStatus: code, status: stageOf(code) ?? null, location: null });
  }
  return newestFirst(result);
}

/**
 * The newest timeline event decides; the display text stands in when the enum is missing. A
 * newest value we cannot map falls back to the newest earlier event that does map.
 */
export function airmeeSnapshot(
  raw: Json,
  token: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = timeline(raw);
  const latest = events.at(-1) ?? {};
  const rawStatus = text(latest["courier_status"]) ?? text(raw["courier_status_formatted"]);
  const codes = events.map((event) => text(event["courier_status"]));
  for (const code of events.length === 0 ? [rawStatus] : codes) {
    if (code !== null && stageOf(code) === undefined && code.toUpperCase() !== NOT_A_STAGE) {
      report(code);
    }
  }
  const status: ParcelStatus | null =
    [rawStatus, ...codes.slice(0, -1).reverse()]
      .map((code) => (code === null ? undefined : stageOf(code)))
      .find((mapped) => mapped !== undefined) ?? null;
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode: token,
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered
      ? epochIso(
          [...events]
            .reverse()
            .find((event) => stageOf(text(event["courier_status"]) ?? "") === "delivered")?.[
            "time_of_event"
          ],
          "s",
        )
      : null,
    // The drop-off window's unit and zone have never been confirmed on the wire; not read yet.
    pickup: status === "at_pickup_point",
    url: `${ORIGIN}/track/${encodeURIComponent(token)}`,
    sender: text(raw["sender_name"]),
    history: history(events),
    raw,
  });
}

const configSchema = z.looseObject({});
/** Per-recipient value the tracking page sends alongside the link token. */
const secretSchema = z.object({ phoneNumberHash: z.string().min(1) });
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

export const airmee = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Airmee",
  countries: ["SE"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "api_key" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track: (context: PluginContext<Config, Secret>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (token) => {
      const raw = await lookUp(context.http, context.secret.phoneNumberHash, token);
      return raw === null
        ? null
        : airmeeSnapshot(raw, token, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
