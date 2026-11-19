import { z } from "zod";
import {
  carrierPattern,
  type PluginHttp,
  asArray,
  defineCarrier,
  epochIso,
  isObject,
  newestFirst,
  readObject,
  ruleStatus,
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
  rulesTrackingUrl,
} from "../../plugin/api.js";

import { fetchAirmeeAccount, smsSignIn } from "./account.js";

const CARRIER_ID = "airmee";
const HOST = "api.airmee.com";
const ORIGIN = "https://tracking.airmee.com";
/** The tracked "code" is the opaque token from the recipient's tracking link. */
const PLAUSIBLE = carrierPattern("airmee");

/** `EDIT` records that the order was amended: a known value, but not a stage. */
const NOT_A_STAGE = "EDIT";

/**
 * The stage a value names: the courier status enum, or the display text the tracker sends when
 * the enum is missing (both in the shared table). Undefined for `EDIT` and unmapped values.
 */
function stageOf(value: string): ParcelStatus | undefined {
  if (value.toUpperCase() === NOT_A_STAGE) {
    return undefined;
  }
  return ruleStatus(CARRIER_ID, value) ?? undefined;
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
    url: rulesTrackingUrl(CARRIER_ID, token),
    sender: text(raw["sender_name"]),
    history: history(events),
    raw,
  });
}

const configSchema = z.looseObject({});
/**
 * A tracking source keeps the per-recipient value the tracking page sends alongside the link
 * token; an account source the token pair from the phone sign-in.
 */
const secretSchema = z.object({
  phoneNumberHash: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
});
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

export const airmee = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Airmee",
  countries: ["SE"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [smsSignIn<Config>(), { type: "api_key", kinds: ["tracking"] }],
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  async fetchAccount(context) {
    const { accessToken, refreshToken } = context.secret;
    if (accessToken === undefined || refreshToken === undefined) {
      throw new SignInRejectedError("Sign in to your Airmee account first.");
    }
    return fetchAirmeeAccount(context, { accessToken, refreshToken }, (raw, reference) => ({
      // The inbox has no tracking-link token; the order id stands in, and there is no page.
      ...airmeeSnapshot(raw, reference, (code) => {
        context.reportUnknown("status_code", code);
      }),
      url: null,
    }));
  },
  track: (context: PluginContext<Config, Secret>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (token) => {
      const hash = context.secret.phoneNumberHash;
      if (hash === undefined) {
        throw new SignInRejectedError("Enter the phone number hash from the tracking page.");
      }
      const raw = await lookUp(context.http, hash, token);
      return raw === null
        ? null
        : airmeeSnapshot(raw, token, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
