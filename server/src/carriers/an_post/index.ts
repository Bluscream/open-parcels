import { z } from "zod";
import {
  asArray,
  defineCarrier,
  isObject,
  isoTime,
  readObject,
  ruleStatus,
  SignInRejectedError,
  snapshot,
  text,
  TransientError,
  UnexpectedResponseError,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  rulesTrackingUrl,
} from "../../plugin/api.js";
import { IDENTITY_HOST, idToken } from "./auth.js";

const CARRIER_ID = "an_post";
const API_HOST = "apim-anpost-mydeliveries.anpost.com";
/** An Post's times carry no offset; they are Irish time. */
const ZONE = "Europe/Dublin";

/** Codes that open a locker or prove delivery; never stored. */
const WITHHELD = new Set(["deliveryPin", "parcelLockerPin"]);

export function anPostSnapshot(item: Json, report: (key: string) => void): ParcelSnapshot | null {
  const barcode = text(item["trackingNumber"]);
  if (barcode === null) {
    return null;
  }
  const category = item["lastTrackingEventCategoryId"];
  // `lastTrackingEventCategoryId`, An Post's own coarse stage, from the shared table.
  const status =
    typeof category === "number" ? ruleStatus(CARRIER_ID, `category:${category}`) : null;
  if (typeof category === "number" && status === null) {
    report(String(category));
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: typeof category === "number" ? String(category) : null,
    delivered,
    deliveredAt: delivered ? isoTime(item["dateDelivered"], { naive: { zone: ZONE } }) : null,
    // A single expected moment, not a window.
    plannedFrom: delivered
      ? null
      : isoTime(item["estimatedDeliveryDateTime"], { naive: { zone: ZONE } }),
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    sender: text(item["retailerName"]),
    receiver: text(item["recipientName"]) ?? text(item["receiverName"]),
    raw: Object.fromEntries(Object.entries(item).filter(([name]) => !WITHHELD.has(name))),
  });
}

const configSchema = z.looseObject({});
const secretSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

async function fetchAccount(context: PluginContext<Config, Secret>): Promise<FetchResult> {
  const { token, uid } = await idToken(context.http, context.session, context.secret);
  const url = new URL(
    `https://${API_HOST}/an-post-my-deliveries-api/v2/api/customer/${encodeURIComponent(uid)}/trackingitems`,
  );
  // This API takes the token bare, without "Bearer".
  const response = await context.http.request(url, {
    headers: { authorization: token, accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    await context.session.save(null);
    throw new SignInRejectedError("An Post refused a token it had just issued.");
  }
  if (response.status !== 200) {
    throw new TransientError(`An Post's deliveries answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "An Post's deliveries");
  const items: unknown = payload["trackingItems"];
  if (payload["success"] !== true || !Array.isArray(items)) {
    throw new UnexpectedResponseError("An Post's deliveries did not report success.");
  }
  const report = (key: string): void => {
    context.reportUnknown("category_id", key);
  };
  const snapshots = asArray(items)
    .filter(isObject)
    .map((item) => anPostSnapshot(item, report))
    .filter((parcel) => parcel !== null);
  return { snapshots, complete: true };
}

export const anPost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "An Post",
  countries: ["IE"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [IDENTITY_HOST]: { intervalMs: 10_000, burst: 2 },
      [API_HOST]: { intervalMs: 10_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
