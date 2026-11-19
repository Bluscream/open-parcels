import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  num,
  parseJsonBody,
  ruleStatus,
  SignInRejectedError,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

const CARRIER_ID = "brt";
/** BRT is DPD's Italian business unit on the shared dpdgroup consumer backend. */
const BUSINESS_UNIT = "BRT";
export const LOGIN_HOST = "login.dpdgroup.com";
export const API_HOST = "www.dpdgroup.com";
const API = `https://${API_HOST}/concept/webservice`;
const HISTORY_LIMIT = 20;
const DETAIL_LIMIT = 30;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });
type Secret = z.infer<typeof secretSchema>;

const sessionSchema = z.object({ token: z.string().min(1) });

/** The dpdgroup app's fixed values live under the `dpd` carrier in the shared rules. */
const appAgent = (): string => carrierKey("dpd", "group_app_user_agent");

function tokenFrom(response: { status: number; body: string }, what: string): string {
  const payload = parseJsonBody(response.body);
  const token = isObject(payload) ? text(payload["access_token"]) : null;
  if (response.status >= 500 || response.status === 429) {
    throw new TransientError(`dpdgroup ${what} answered HTTP ${response.status}.`);
  }
  if (token === null) {
    throw new UnexpectedResponseError(`dpdgroup ${what} gave no token.`);
  }
  return token;
}

/**
 * The app's sign-in: the user's password at the group login, the app's own client token, and
 * the exchange of the first for a consumer token in the business unit.
 */
export async function signIn(http: PluginHttp, secret: Secret): Promise<string> {
  const login = await http.request(
    new URL(`https://${LOGIN_HOST}/auth/realms/login/protocol/openid-connect/token`),
    {
      method: "POST",
      headers: { "user-agent": appAgent(), accept: "application/json" },
      body: new URLSearchParams({
        client_id: carrierKey("dpd", "group_login_client_id"),
        grant_type: "password",
        scope: "openid",
        username: secret.username,
        password: secret.password,
      }),
    },
  );
  if (login.status === 400 || login.status === 401) {
    throw new SignInRejectedError("BRT rejected the e-mail address or password.");
  }
  const userToken = tokenFrom(login, "login");
  const guest = await http.request(new URL(`${API}/oauth/token?grant_type=client_credentials`), {
    method: "POST",
    headers: {
      authorization: `Basic ${carrierKey("dpd", "group_app_credentials")}`,
      "content-type": "application/json",
      "user-agent": appAgent(),
    },
  });
  const appToken = tokenFrom(guest, "app token");
  const sso = await http.request(new URL(`${API}/users/login/consignee-sso?bu=${BUSINESS_UNIT}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "text/plain",
      "user-agent": appAgent(),
    },
    body: userToken,
  });
  return tokenFrom(sso, "consumer sign-in");
}

/** dpdgroup times carry no offset; the status names its zone. */
function zoned(value: unknown, zone: string | null): string | null {
  return isoTime(value, { naive: zone === null ? "utc" : { zone } });
}

function history(detail: Json): SnapshotEvent[] {
  return newestFirst(
    asList(detail["parcelEvents"])
      .filter(isObject)
      .flatMap((event) => {
        const date = text(event["date"]);
        const time = text(event["time"]);
        const at = date === null || time === null ? null : zoned(`${date}T${time}`, null);
        const rawStatus = text(event["eventTypeText"]) ?? text(event["eventType"]);
        return at === null || rawStatus === null
          ? []
          : [
              {
                at,
                rawStatus,
                status: ruleStatus(CARRIER_ID, text(event["eventType"])),
                location: null,
              },
            ];
      }),
  ).slice(0, HISTORY_LIMIT);
}

function plannedWindow(shipment: Json, zone: string | null) {
  const fmp = asObject(shipment["fmpDeliveryDateAndTime"]);
  const range = asObject(fmp["timeRange"]);
  const day = text(fmp["deliveryDate"]) ?? text(shipment["deliveryDate"]);
  const from = text(range["from"]) ?? text(shipment["deliveryTimeFrom"]);
  const to = text(range["to"]) ?? text(shipment["deliveryTimeTo"]);
  if (day === null) {
    return { plannedFrom: null, plannedTo: null };
  }
  if (from === null || to === null) {
    return { plannedFrom: zoned(day, zone), plannedTo: zoned(`${day}T23:59:59`, zone) };
  }
  return { plannedFrom: zoned(`${day}T${from}`, zone), plannedTo: zoned(`${day}T${to}`, zone) };
}

export function shipmentSnapshot(
  shipment: Json,
  detail: Json | null,
  direction: "incoming" | "outgoing",
  report: (key: string) => void,
): ParcelSnapshot {
  const state = asObject(shipment["status"]);
  const description = text(state["description"]);
  const zone = text(state["eventDateAndTimeZoneId"]);
  const delivered = description === "DELIVERED";
  const pickup = text(state["deliveryType"]) === "PARCELSHOP";
  const receiver = text(asObject(detail?.["receiver"])["name"]);
  const number = text(shipment["parcelNumber"]) ?? "";
  return snapshot({
    carrier: CARRIER_ID,
    barcode: number,
    direction,
    status: ruleStatus(CARRIER_ID, description, report),
    rawStatus: description,
    delivered,
    deliveredAt: delivered
      ? (zoned(state["eventDateAndTime"], zone) ?? zoned(shipment["deliveryDate"], null))
      : null,
    ...(delivered ? {} : plannedWindow(shipment, zone)),
    pickup,
    // For a ParcelShop delivery the detail names the shop where the receiver would be.
    pickupPoint: pickup ? receiver : null,
    receiver: pickup ? null : receiver,
    sender: text(shipment["senderName"]),
    url: rulesTrackingUrl(CARRIER_ID, number),
    weightKg: num(detail?.["weight"]),
    history: detail === null ? [] : history(detail),
    raw: shipment,
  });
}

class BrtAccount {
  constructor(
    private readonly http: PluginHttp,
    private readonly secret: Secret,
    private token: string | null,
  ) {}

  get currentToken(): string | null {
    return this.token;
  }

  /** A refused token (401/403) leads to one new sign-in; a network error never does. */
  async call(url: URL, body?: string): Promise<{ status: number; body: string }> {
    const send = async (token: string) =>
      this.http.request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": appAgent(),
        },
        ...(body === undefined ? {} : { body }),
      });
    if (this.token !== null) {
      const first = await send(this.token);
      if (first.status !== 401 && first.status !== 403) {
        return first;
      }
    }
    this.token = await signIn(this.http, this.secret);
    return send(this.token);
  }
}

async function fetchAccount(context: PluginContext<Config, Secret>) {
  const stored = sessionSchema.safeParse(context.session.load());
  const account = new BrtAccount(
    context.http,
    context.secret,
    stored.success ? stored.data.token : null,
  );
  const report = unknownReporter(context, "status_code");
  try {
    const list = await account.call(
      new URL(`${API}/v7/parcels?bu=${BUSINESS_UNIT}&lang=en`),
      JSON.stringify({
        incomingParcels: [],
        sendingParcels: [],
        confirmedParcels: null,
        shipmentCollections: [],
        confirmedShipmentCollections: null,
      }),
    );
    if (list.status !== 200) {
      throw new TransientError(`BRT parcels answered HTTP ${list.status}.`);
    }
    const payload = parseJsonBody(list.body);
    if (!isObject(payload)) {
      throw new UnexpectedResponseError("BRT parcels answered without a JSON object.");
    }
    const groups: readonly (readonly ["incoming" | "outgoing", Json[]])[] = [
      ["incoming", asList(payload["incomingShipments"]).filter(isObject)],
      ["outgoing", asList(payload["sendingShipments"]).filter(isObject)],
    ];
    const snapshots: ParcelSnapshot[] = [];
    let details = 0;
    const listed = groups.flatMap(([direction, shipments]) =>
      shipments.map((shipment) => ({
        direction,
        shipment,
        number: text(shipment["parcelNumber"]),
      })),
    );
    for (const { direction, shipment, number } of listed) {
      if (number === null) {
        continue;
      }
      // Details (receiver, weight, events) cost one call each; delivered parcels skip them.
      const wantDetail =
        text(asObject(shipment["status"])["description"]) !== "DELIVERED" && details < DETAIL_LIMIT;
      details += wantDetail ? 1 : 0;
      const detail = wantDetail ? await readDetail(account, number, shipment, direction) : null;
      snapshots.push(shipmentSnapshot(shipment, detail, direction, report));
    }
    return { snapshots, complete: true };
  } finally {
    const token = account.currentToken;
    if (token !== null && token !== (stored.success ? stored.data.token : null)) {
      await context.session.save({ token });
    }
  }
}

async function readDetail(account: BrtAccount, number: string, shipment: Json, direction: string) {
  const url = new URL(`${API}/v10/parcels/details/${encodeURIComponent(number)}`);
  url.search = new URLSearchParams({
    parcelType: direction === "outgoing" ? "SENDING" : "INCOMING",
    businessUnit: BUSINESS_UNIT,
    lang: "en",
    continueWithoutVerification: "false",
    ...(text(shipment["shipmentBUCode"]) === null
      ? {}
      : { shipmentBUCode: text(shipment["shipmentBUCode"]) ?? "" }),
  }).toString();
  const response = await account.call(url);
  const payload = response.status === 200 ? parseJsonBody(response.body) : null;
  return isObject(payload) ? payload : null;
}

/** BRT (Italy): the MyBRT account, read through DPD's shared consumer backend. */
export const brt = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "BRT",
  countries: ["IT"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [LOGIN_HOST]: { intervalMs: 30_000, burst: 1 },
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
