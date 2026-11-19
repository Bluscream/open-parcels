import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  defineCarrier,
  epoch,
  isObject,
  isoTime,
  newestFirst,
  num,
  parseJsonBody,
  pastedRedirect,
  ruleStatus,
  SignInRejectedError,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type HttpResponse,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

const CARRIER_ID = "posten_bring";
export const API_HOST = "api.posten.no";
const MARGIN_MS = 300_000;
const LOOKBACK_DAYS = 30;
const MAX_PAGES = 25;
const HISTORY_LIMIT = 20;

/** Posten and Bring are one account backend behind two brands, each with its own app client. */
const BRANDS = {
  posten: { host: "id.posten.no", redirect: "posten://login" },
  bring: { host: "login.bring.com", redirect: "bring://login" },
} as const;
type Brand = keyof typeof BRANDS;

const configSchema = z.looseObject({ brand: z.enum(["posten", "bring"]).default("bring") });
type Config = z.infer<typeof configSchema>;
const secretSchema = z.object({ refreshToken: z.string().min(1) });
type Secret = z.infer<typeof secretSchema>;

/** The app's client pair (in the shared rules) authenticates every token request. */
function clientAuth(brand: Brand): string {
  const pair = `${carrierKey(CARRIER_ID, `${brand}_client_id`)}:${carrierKey(CARRIER_ID, `${brand}_client_secret`)}`;
  return `Basic ${Buffer.from(pair).toString("base64")}`;
}

interface Tokens {
  readonly access: string;
  readonly refresh: string | null;
  readonly lifetimeMs: number;
}

/** Only an explicit refusal of the grant or the app client means the user must sign in again. */
async function postToken(http: PluginHttp, brand: Brand, form: Record<string, string>) {
  const response = await http.request(
    new URL(`https://${BRANDS[brand].host}/api/oauth/accesstoken`),
    {
      method: "POST",
      headers: { accept: "application/json", authorization: clientAuth(brand) },
      body: new URLSearchParams(form),
    },
  );
  const body = asObject(parseJsonBody(response.body));
  const error = text(body["error"]);
  if (
    [400, 401, 403].includes(response.status) &&
    (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client")
  ) {
    throw new SignInRejectedError(`Posten Bring refused the sign-in (${error}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`Posten Bring's token endpoint answered HTTP ${response.status}.`);
  }
  const access = text(body["access_token"]);
  if (access === null) {
    throw new UnexpectedResponseError("Posten Bring's token answer has no access token.");
  }
  return {
    access,
    refresh: text(body["refresh_token"]),
    lifetimeMs: (num(body["expires_in"]) ?? 3600) * 1000,
  } satisfies Tokens;
}

const signInState = z.object({ state: z.string(), brand: z.enum(["posten", "bring"]) });

/** The app's browser sign-in, finished by pasting the `posten://` or `bring://` address back. */
const signIn = pastedRedirect<Config, Secret>({
  message:
    "Open the address and sign in. The browser then tries to open the app; copy that " +
    "posten:// or bring:// address (from the address bar or the developer tools) and paste it.",
  start: (context) => {
    const brand = context.config.brand;
    const state = randomBytes(24).toString("base64url");
    const url = new URL(`https://${BRANDS[brand].host}/api/oauth/authorizations/new`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: carrierKey(CARRIER_ID, `${brand}_client_id`),
      redirect_uri: BRANDS[brand].redirect,
      state,
      lang: "en",
      is_app: "true",
      brand,
    }).toString();
    return Promise.resolve({ url: url.toString(), state: { state, brand } });
  },
  finish: async (context, raw, pasted) => {
    const expected = signInState.parse(raw);
    const redirect = BRANDS[expected.brand].redirect;
    const trimmed = pasted.trim();
    const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
    if (url === null || !trimmed.startsWith(redirect)) {
      throw new SignInRejectedError(`The pasted address does not start with ${redirect}.`);
    }
    const code = url.searchParams.get("code");
    if (code === null || url.searchParams.get("state") !== expected.state) {
      throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
    }
    const tokens = await postToken(context.http, expected.brand, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      response_type: "code",
    });
    if (tokens.refresh === null) {
      throw new UnexpectedResponseError("Posten Bring gave no refresh token.");
    }
    return { refreshToken: tokens.refresh };
  },
});

const storedSchema = z.object({
  base: z.string(),
  refreshToken: z.string().min(1),
  accessToken: z.string().nullable(),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * The bearer session. Refresh tokens rotate on every use, so the newest is saved before the
 * inbox is called. A refused bearer is renewed once; a bearer refused after renewal is the
 * inbox's problem, not the sign-in's.
 */
class Session {
  #stored: Stored;

  constructor(private readonly context: PluginContext<Config, Secret>) {
    const signedInWith = context.secret.refreshToken;
    const parsed = storedSchema.safeParse(context.session.load());
    const base = fingerprint(signedInWith);
    this.#stored =
      parsed.success && parsed.data.base === base
        ? parsed.data
        : { base, refreshToken: signedInWith, accessToken: null, expiresAt: 0 };
  }

  async #renew(): Promise<string> {
    const tokens = await postToken(this.context.http, this.context.config.brand, {
      grant_type: "refresh_token",
      refresh_token: this.#stored.refreshToken,
    });
    this.#stored = {
      ...this.#stored,
      refreshToken: tokens.refresh ?? this.#stored.refreshToken,
      accessToken: tokens.access,
      expiresAt: this.context.clock.now().getTime() + tokens.lifetimeMs,
    };
    await this.context.session.save(this.#stored);
    return tokens.access;
  }

  async inbox(body: Json): Promise<Json> {
    const send = async (token: string): Promise<HttpResponse> =>
      this.context.http.request(new URL(`https://${API_HOST}/parcel-api/v1/parcel`), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    const { accessToken, expiresAt } = this.#stored;
    const fresh =
      accessToken !== null && this.context.clock.now().getTime() < expiresAt - MARGIN_MS;
    let response = await send(fresh ? accessToken : await this.#renew());
    if (response.status === 401 || response.status === 403) {
      response = await send(await this.#renew());
    }
    if (response.status !== 200) {
      throw new TransientError(`Posten Bring's inbox answered HTTP ${response.status}.`);
    }
    const payload = parseJsonBody(response.body);
    if (!isObject(payload)) {
      throw new UnexpectedResponseError("Posten Bring's inbox answered without a JSON object.");
    }
    return payload;
  }
}

const DELIVERED_EVENTS = new Set(["delivered", "delivered_bag_on_door"]);
const RETURNED_EVENTS = new Set(["return", "delivered_sender"]);

const when = (value: unknown): string | null => isoTime(value, { naive: "utc", epoch: "ms" });

/** The newest event of the given types: a later bookkeeping event must not hide a delivery. */
function latestOf(events: readonly Json[], types: ReadonlySet<string>): Json | null {
  let best: Json | null = null;
  for (const event of events) {
    const type = text(event["type"])?.toLowerCase() ?? "";
    if (
      types.has(type) &&
      when(event["date"]) !== null &&
      (best === null || epoch(when(event["date"])) >= epoch(when(best["date"])))
    ) {
      best = event;
    }
  }
  return best;
}

/** Archived parcels have no delivered state of their own; their newest conclusive event decides. */
function statusOf(raw: Json, events: readonly Json[], report: (key: string) => void) {
  const status = text(raw["status"])?.toLowerCase() ?? null;
  if (status !== "archived" && status !== "archived_by_user") {
    return ruleStatus(CARRIER_ID, status, report);
  }
  const conclusive = latestOf(events, new Set([...DELIVERED_EVENTS, ...RETURNED_EVENTS]));
  const type = text(conclusive?.["type"])?.toLowerCase() ?? "";
  return DELIVERED_EVENTS.has(type) ? "delivered" : RETURNED_EVENTS.has(type) ? "returning" : null;
}

function window(raw: Json): { plannedFrom: string | null; plannedTo: string | null } {
  const time = asObject(asObject(raw["delivery"])["deliveryTime"]);
  const range = asObject(time["deliveryWindow"]);
  const start = when(range["start"]);
  const end = when(range["end"]);
  // The bare date can be local midnight sent as UTC; it is only used without a window.
  return start !== null || end !== null
    ? { plannedFrom: start, plannedTo: end }
    : { plannedFrom: when(time["date"]), plannedTo: null };
}

export function toSnapshot(raw: Json, report: (key: string) => void): ParcelSnapshot | null {
  const number = text(raw["parcelNumber"]);
  if (number === null) {
    return null;
  }
  const events = asList(raw["events"]).filter(isObject);
  const status = statusOf(raw, events, report);
  const delivered = status === "delivered";
  const pickup = status === "at_pickup_point";
  const history: SnapshotEvent[] = newestFirst(
    events.flatMap((event) => {
      const at = when(event["date"]);
      const rawStatus = text(event["description"]) ?? text(event["type"]);
      // Event types are their own open vocabulary; they are shown, never mapped.
      return at === null || rawStatus === null
        ? []
        : [{ at, rawStatus, status: null, location: null }];
    }),
  ).slice(0, HISTORY_LIMIT);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: number,
    direction: text(raw["direction"])?.toLowerCase() === "send" ? "outgoing" : "incoming",
    status,
    rawStatus: text(raw["status"]),
    delivered,
    deliveredAt: delivered ? when(latestOf(events, DELIVERED_EVENTS)?.["date"]) : null,
    ...(delivered ? {} : window(raw)),
    pickup,
    pickupPoint: pickup ? text(asObject(raw["pickupPoint"])["name"]) : null,
    url: rulesTrackingUrl(CARRIER_ID, number),
    sender: text(asObject(raw["sender"])["name"]),
    receiver: text(asObject(raw["recipient"])["name"]),
    weightKg: num(raw["weightInKg"]),
    history,
    raw,
  });
}

/**
 * The inbox is an incremental sync: a rolling window of recently updated parcels, paged while
 * `remainingCount` stays positive, up to a page cap; a cursor that stops advancing ends it. The
 * read is never complete: a parcel outside the window is not gone.
 */
async function fetchAccount(context: PluginContext<Config, Secret>) {
  const session = new Session(context);
  const since = new Date(context.clock.now().getTime() - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const parcels = new Map<string, Json>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const envelope = await session.inbox({ lastUpdated: since, exclude: [...parcels.keys()] });
    let added = 0;
    for (const parcel of asList(envelope["parcels"]).filter(isObject)) {
      const number = text(parcel["parcelNumber"]);
      if (number !== null) {
        added += parcels.has(number) ? 0 : 1;
        parcels.set(number, parcel);
      }
    }
    const remaining = num(envelope["remainingCount"]) ?? 0;
    if (remaining <= 0) {
      break;
    }
    if (added === 0) {
      context.logger.warn({ remaining }, "Posten Bring's inbox stopped advancing.");
      break;
    }
  }
  const report = unknownReporter(context, "status");
  const snapshots = [...parcels.values()]
    .map((raw) => toSnapshot(raw, report))
    .filter((parcel): parcel is ParcelSnapshot => parcel !== null);
  // Only a rolling window is read, so a parcel missing from it is not gone.
  return { snapshots, complete: false };
}

/** Posten and Bring (Norway): the app account's parcel inbox. */
export const postenBring = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Posten / Bring",
  countries: ["NO"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn,
  http: {
    limits: {
      [API_HOST]: { intervalMs: 5_000, burst: 2 },
      "id.posten.no": { intervalMs: 10_000, burst: 2 },
      "login.bring.com": { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
