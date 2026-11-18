import { z } from "zod";
import {
  defineCarrier,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { asObject, isObject, objects, readObject, text, type Json } from "../../plugin/parse.js";
import { finishSignIn, LOGIN_HOST, PostnlSession, startSignIn } from "./auth.js";
import { CARRIER_ID, shipmentSnapshot } from "./parcel.js";

const API_HOST = "jouw.postnl.nl";
/** At most this many track & trace calls per run; delivered parcels never need one. */
export const DETAIL_LIMIT = 25;

const SHIPMENTS_QUERY = `query {
  trackedShipments {
    receiverShipments { ...shipment }
    senderShipments { ...shipment }
  }
}
fragment shipment on TrackedShipmentResultType {
  key creationDateTime title barcode delivered deliveredTimeStamp deliveryWindowFrom
  deliveryWindowTo deliveryWindowType detailsUrl shipmentType receiverTitle deliveryAddressType
}`;

const configSchema = z.object({});
const secretSchema = z.object({ refreshToken: z.string().min(1) }).nullable();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

/** A signed-in request. PostNL refusing the token leads to one refresh, never more. */
async function signed(
  context: PluginContext<Config, Secret>,
  session: PostnlSession,
  url: URL,
  body?: string,
) {
  const send = async (token: string) =>
    context.http.request(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
  let response = await send(await session.accessToken());
  if (response.status === 401) {
    response = await send(await session.renew());
    if (response.status === 401) {
      throw new SignInRejectedError("PostNL refuses a freshly refreshed sign-in.");
    }
  }
  return response;
}

async function shipments(
  context: PluginContext<Config, Secret>,
  session: PostnlSession,
): Promise<Json> {
  const url = new URL(`https://${API_HOST}/account/api/graphql`);
  const response = await signed(context, session, url, JSON.stringify({ query: SHIPMENTS_QUERY }));
  if (response.status !== 200) {
    throw new TransientError(`PostNL's account answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "PostNL's account");
  const tracked = asObject(payload["data"])["trackedShipments"];
  if (!isObject(tracked)) {
    throw new UnexpectedResponseError("PostNL's account answered without a shipment list.");
  }
  return tracked;
}

/** The colli for one shipment, or null when track & trace has none for its barcode. */
async function colli(
  context: PluginContext<Config, Secret>,
  session: PostnlSession,
  shipment: Json,
): Promise<Json | null> {
  const key = text(shipment["key"]);
  const barcode = text(shipment["barcode"]);
  if (key === null || barcode === null) {
    return null;
  }
  const url = new URL(
    `https://${API_HOST}/track-and-trace/api/trackAndTrace/${encodeURIComponent(key)}`,
  );
  url.searchParams.set("language", "nl");
  const response = await signed(context, session, url);
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`PostNL track & trace answered HTTP ${response.status}.`);
  }
  const found = asObject(readObject(response, "PostNL track & trace")["colli"])[barcode];
  return isObject(found) ? found : null;
}

async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("Sign in to your PostNL account first.");
  }
  const session = new PostnlSession(context, context.secret.refreshToken);
  const tracked = await shipments(context, session);
  const report = (kind: string, key: string): void => {
    context.reportUnknown(kind, key);
  };
  const snapshots: ParcelSnapshot[] = [];
  let details = 0;
  const lists = [
    ["receiverShipments", "incoming"],
    ["senderShipments", "outgoing"],
  ] as const;
  for (const [list, direction] of lists) {
    for (const shipment of objects(tracked[list])) {
      if (text(shipment["barcode"]) === null) {
        continue;
      }
      const wantDetail = shipment["delivered"] !== true && details < DETAIL_LIMIT;
      details += wantDetail ? 1 : 0;
      const found = wantDetail ? await colli(context, session, shipment) : null;
      snapshots.push(shipmentSnapshot({ shipment, direction, colli: found }, report));
    }
  }
  return { snapshots, complete: true };
}

/** PostNL: the account's tracked shipments, signed in through PostNL's own login page. */
export const postnl = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "PostNL",
  countries: ["NL", "BE"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: {
    type: "pasted_redirect",
    start: () => Promise.resolve(startSignIn()),
    finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
  },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [LOGIN_HOST]: { intervalMs: 30_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
