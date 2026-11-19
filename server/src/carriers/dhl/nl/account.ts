import {
  CookieJar,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isoTime,
  objects,
  readJson,
  restoreJar,
  serializeJar,
  snapshot,
  text,
  type FetchResult,
  type InteractiveSignIn,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
} from "../../../plugin/api.js";
import { dutchTrackingUrl } from "../constants.js";
import { mapEvent } from "../gateway.js";

export const NL_HOST = "my.dhlecommerce.nl";
const LOGIN_URL = `https://${NL_HOST}/api/user/login`;
const PARCELS_URL = `https://${NL_HOST}/receiver-parcel-api/parcels`;
/** The most sent shipments the account answers with in one list. */
const SENT_LIMIT = 250;
const SENT_URL = `https://${NL_HOST}/api/orders/sentShipments?max=${String(SENT_LIMIT)}`;
const XSRF_COOKIE = "XSRF-TOKEN";
const UTC = { naive: "utc" } as const;

export interface NlCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * Signs in with email and password. The cookies it sets are the session; only a 401/403 is a
 * refusal, anything else is DHL being unavailable.
 */
async function logIn(http: PluginHttp, jar: CookieJar, credentials: NlCredentials): Promise<void> {
  const response = await http.request(new URL(LOGIN_URL), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    jar,
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError(`DHL refused the email and password (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`DHL's login answered HTTP ${response.status}.`);
  }
}

/** The second flow of the DHL plug-in: the Dutch account, signed in with email and password. */
export function nlSignIn<Config>(options: {
  readonly when: (config: Config) => boolean;
}): InteractiveSignIn<Config, { readonly nl: NlCredentials }> {
  return {
    type: "interactive",
    id: "nl_account",
    label: "DHL Netherlands account (email and password)",
    kinds: ["account"],
    when: options.when,
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [
            { name: "email", label: "Email", type: "email" },
            { name: "password", label: "Password", type: "password" },
          ],
          message: "The email and password of your my.dhlecommerce.nl account.",
        },
        state: null,
      }),
    async continue(context, _state, input) {
      const credentials = { email: input["email"] ?? "", password: input["password"] ?? "" };
      await logIn(context.http, new CookieJar(), credentials);
      // The password is kept: DHL's session cookies are short-lived and only a new login renews them.
      return { secret: { nl: credentials } };
    },
  };
}

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "session" | "reportUnknown">;

async function xsrf(jar: CookieJar): Promise<Record<string, string>> {
  const cookies = await jar.getCookies(`https://${NL_HOST}/`);
  const token = cookies.find((cookie) => cookie.key === XSRF_COOKIE)?.value;
  return token === undefined ? {} : { "x-xsrf-token": token };
}

/** Whether this run has signed in again already; a run does so at most once. */
interface LoginBudget {
  relogged: boolean;
}

/** One authenticated GET; signs in again, once per run, when DHL says the session is gone. */
async function getJson(
  deps: Deps,
  jar: CookieJar,
  credentials: NlCredentials,
  url: string,
  budget: LoginBudget,
): Promise<unknown> {
  for (;;) {
    const response = await deps.http.request(new URL(url), {
      headers: { accept: "application/json", ...(await xsrf(jar)) },
      jar,
    });
    if (response.status === 401 || response.status === 403) {
      if (budget.relogged) {
        throw new SignInRejectedError("DHL refused a fresh login session.");
      }
      budget.relogged = true;
      await logIn(deps.http, jar, credentials);
      await deps.session.save(serializeJar(jar));
      continue;
    }
    if (response.status !== 200) {
      throw new TransientError(`DHL's account answered HTTP ${response.status}.`);
    }
    return readJson(response, "DHL");
  }
}

function deliveryWindow(parcel: Json): { from: string | null; to: string | null } {
  const indication = asObject(parcel["receivingTimeIndication"]);
  const type = text(indication["indicationType"]);
  if (type === "MomentIndication") {
    return { from: isoTime(indication["moment"], UTC), to: null };
  }
  if (type === "IntervalIndication") {
    return { from: isoTime(indication["start"], UTC), to: isoTime(indication["end"], UTC) };
  }
  return { from: null, to: null };
}

function trackingUrl(parcel: Json, barcode: string): string | null {
  // The portal looks parcels up by the receiver's postcode, not the pickup point's.
  const postal =
    text(asObject(asObject(parcel["receiver"])["address"])["postalCode"]) ??
    text(asObject(asObject(parcel["destination"])["address"])["postalCode"]);
  return postal === null ? null : dutchTrackingUrl(barcode, postal);
}

/** One parcel of the account. Returns and sent shipments travel away from the user. */
export function normalizeNl(deps: Deps, parcel: Json, sent: boolean): ParcelSnapshot | null {
  const barcode = text(parcel["barcode"]);
  if (barcode === null) {
    return null;
  }
  const status = mapEvent(deps, parcel);
  const delivered = text(parcel["category"]) === "DELIVERED";
  const destination = asObject(parcel["destination"]);
  const pickup = text(destination["locationType"]) === "SERVICEPOINT";
  const window = deliveryWindow(parcel);
  return snapshot({
    carrier: "dhl",
    barcode,
    direction: sent || parcel["isReturn"] === true ? "outgoing" : "incoming",
    // A finished return also says DELIVERED: it is back with the sender.
    status: delivered ? "delivered" : status,
    rawStatus: text(parcel["status"]) ?? text(parcel["category"]),
    delivered,
    deliveredAt: delivered ? window.from : null,
    plannedFrom: delivered ? null : window.from,
    plannedTo: delivered ? null : window.to,
    pickup,
    pickupPoint: pickup ? text(destination["name"]) : null,
    sender: text(asObject(parcel["sender"])["name"]),
    receiver: text(asObject(parcel["receiver"])["name"]),
    url: trackingUrl(parcel, barcode),
    raw: parcel,
  });
}

/** Everything the Dutch account lists: received parcels, returns and sent shipments. */
export async function fetchNlAccount(deps: Deps, credentials: NlCredentials): Promise<FetchResult> {
  const jar = restoreJar(deps.session.load());
  const budget: LoginBudget = { relogged: false };
  const received = asObject(await getJson(deps, jar, credentials, PARCELS_URL, budget))["parcels"];
  const sent = await getJson(deps, jar, credentials, SENT_URL, budget);
  if (!Array.isArray(received) || !Array.isArray(sent)) {
    throw new UnexpectedResponseError("DHL's account answered without parcel lists.");
  }
  await deps.session.save(serializeJar(jar));
  const snapshots = [
    ...objects(received).map((parcel) => normalizeNl(deps, parcel, false)),
    ...objects(sent)
      .filter((shipment) => text(shipment["type"]) === "outgoing")
      .map((shipment) => normalizeNl(deps, shipment, true)),
  ].filter((parcel) => parcel !== null);
  // The sent list is cut at SENT_LIMIT; a full one may hold more, so nothing missing is gone.
  return { snapshots, complete: sent.length < SENT_LIMIT };
}
