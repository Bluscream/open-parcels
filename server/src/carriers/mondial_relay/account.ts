import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  isObject,
  isoTime,
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
  type FetchResult,
  type InteractiveSignIn,
  type HttpResponse,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID } from "./shared.js";

export const ACCOUNT_HOST = "account.inpost-group.com";
export const BFF_HOST = "mobile-app-bff.mondialrelay.app";
const REDIRECT_URI = `https://${ACCOUNT_HOST}/callback`;
const PAGE_SIZE = 20;
const MAX_PAGES = 25;
const MARGIN_MS = 60_000;
const TRACING_TIME = { naive: { zone: "Europe/Paris" }, epoch: "auto" } as const;
const MARKET_LANGUAGES: Readonly<Record<string, string>> = {
  FR: "fr-FR",
  BE: "fr-BE",
  NL: "nl-NL",
  ES: "es-ES",
  PT: "pt-PT",
};

export interface AccountSecret {
  readonly refreshToken: string;
  readonly deviceId: string;
}

const clientId = (): string => carrierKey(CARRIER_ID, "account_client_id");

/**
 * The app backend checks a signature next to the bearer: a fresh nonce and epoch-second stamp,
 * and SHA-256 applied twice over the app's fixed signing value (in the shared rules) followed by
 * both. A reused nonce or stamp is refused as stale, so each request signs anew.
 */
export function signatureHeaders(now: Date, nonce: string = randomUUID()): Record<string, string> {
  const stamp = String(Math.floor(now.getTime() / 1000));
  const inner = createHash("sha256")
    .update(`${carrierKey(CARRIER_ID, "account_signing_value")}${nonce}${stamp}`)
    .digest("hex");
  return {
    "X-MR-Param1": nonce,
    "X-MR-Param2": stamp,
    "X-MR-API-KEY": createHash("sha256").update(inner).digest("hex"),
  };
}

async function postToken(http: PluginHttp, form: Record<string, string>) {
  const response = await http.request(new URL(`https://${ACCOUNT_HOST}/oauth2/token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  const body = asObject(parseJsonBody(response.body));
  if (response.status === 400 || response.status === 401) {
    throw new SignInRejectedError(
      `The Mondial Relay sign-in was refused (${text(body["error"]) ?? String(response.status)}).`,
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`Mondial Relay's token endpoint answered HTTP ${response.status}.`);
  }
  const access = text(body["access_token"]);
  if (access === null) {
    throw new UnexpectedResponseError("Mondial Relay's token answer has no access token.");
  }
  return {
    access,
    refresh: text(body["refresh_token"]),
    lifetimeMs: (num(body["expires_in"]) ?? 900) * 1000,
  };
}

const flowState = z.object({ verifier: z.string(), state: z.string() });

/**
 * The app's sign-in (InPost Group, PKCE). Its own redirect is a deep link, so the user signs in
 * in a browser and pastes the callback address back. Brand and market are not cosmetic: without
 * them the sign-in page only accepts Polish phone numbers.
 */
export function accountSignIn<Config extends { market?: string | undefined }>(): InteractiveSignIn<
  Config,
  AccountSecret
> {
  return pastedRedirect<Config, AccountSecret>({
    id: "account",
    label: "Mondial Relay account (sign in in your browser)",
    kinds: ["account"],
    start: (context) => {
      const market = context.config.market ?? "FR";
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const url = new URL(`https://${ACCOUNT_HOST}/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId(),
        redirect_uri: REDIRECT_URI,
        scope: "openid",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        nonce: randomBytes(24).toString("base64url"),
        response_mode: "query",
        brand: "mr",
        lang: MARKET_LANGUAGES[market] ?? "fr-FR",
        supported_markets: market,
      }).toString();
      return Promise.resolve({ url: url.toString(), state: { verifier, state } });
    },
    finish: async (context, raw, pasted) => {
      const expected = flowState.parse(raw);
      const trimmed = pasted.trim();
      const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
      if (url === null || `${url.origin}${url.pathname}` !== REDIRECT_URI) {
        throw new SignInRejectedError(`The pasted address does not start with ${REDIRECT_URI}.`);
      }
      const code = url.searchParams.get("code");
      if (code === null || url.searchParams.get("state") !== expected.state) {
        throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
      }
      const tokens = await postToken(context.http, {
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: expected.verifier,
        code,
      });
      if (tokens.refresh === null) {
        throw new UnexpectedResponseError("Mondial Relay granted no offline access.");
      }
      return { refreshToken: tokens.refresh, deviceId: randomUUID() };
    },
  });
}

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
 * The signed-in backend. A 401 renews the token once; a 403 with a valid bearer means the
 * signature was refused, which a new sign-in cannot fix, so it stops the run as transient.
 */
class Backend {
  #stored: Stored;

  constructor(
    private readonly context: PluginContext<unknown, unknown>,
    private readonly secret: AccountSecret,
  ) {
    const parsed = storedSchema.safeParse(context.session.load());
    const base = fingerprint(secret.refreshToken);
    this.#stored =
      parsed.success && parsed.data.base === base
        ? parsed.data
        : { base, refreshToken: secret.refreshToken, accessToken: null, expiresAt: 0 };
  }

  async #renew(): Promise<string> {
    const tokens = await postToken(this.context.http, {
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

  async get(path: string, query: Record<string, string>): Promise<Json> {
    const url = new URL(`https://${BFF_HOST}/api/${path}`);
    url.search = new URLSearchParams(query).toString();
    const send = async (token: string): Promise<HttpResponse> =>
      this.context.http.request(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": carrierKey(CARRIER_ID, "account_user_agent"),
          "device-uid": this.secret.deviceId,
          "accept-language": "en",
          "X-OriginApp": "MR",
          ...signatureHeaders(this.context.clock.now()),
        },
      });
    const { accessToken, expiresAt } = this.#stored;
    const fresh =
      accessToken !== null && this.context.clock.now().getTime() < expiresAt - MARGIN_MS;
    let response = await send(fresh ? accessToken : await this.#renew());
    if (response.status === 401) {
      response = await send(await this.#renew());
      if (response.status === 401) {
        throw new SignInRejectedError("Mondial Relay refused a freshly renewed session.");
      }
    }
    if (response.status === 403) {
      throw new TransientError("Mondial Relay refused the request signature.");
    }
    if (response.status !== 200) {
      throw new TransientError(`Mondial Relay ${path} answered HTTP ${response.status}.`);
    }
    const payload = parseJsonBody(response.body);
    if (!isObject(payload) || !Array.isArray(payload["list"])) {
      throw new UnexpectedResponseError(`Mondial Relay ${path} answered without a list.`);
    }
    return payload;
  }

  async list(path: string): Promise<Json[]> {
    // The result counts as complete, so every page must be read: a list whose page count is
    // missing or beyond the cap stops the run instead of dropping the later pages' parcels.
    const items: Json[] = [];
    for (let page = 0; ; page += 1) {
      const envelope = await this.get(path, {
        pageIndex: String(page),
        pageSize: String(PAGE_SIZE),
      });
      items.push(...asList(envelope["list"]).filter(isObject));
      const total = num(envelope["totalPages"]);
      if (total === null || !Number.isInteger(total) || total < 0) {
        throw new UnexpectedResponseError(`Mondial Relay ${path} answered without a page count.`);
      }
      if (total > MAX_PAGES) {
        throw new UnexpectedResponseError(
          `Mondial Relay ${path} has ${total} pages, more than the ${MAX_PAGES} read.`,
        );
      }
      if (page >= total - 1) {
        return items;
      }
    }
  }
}

export function accountSnapshot(
  raw: Json,
  direction: "incoming" | "outgoing",
  report: (key: string) => void,
): ParcelSnapshot | null {
  const expedition = asObject(raw["expedition"]);
  const barcode = text(expedition["shipmentId"]) ?? text(expedition["tracingCode"]);
  if (barcode === null) {
    return null;
  }
  const step = text(expedition["stepSection"]);
  // The app's step sections are `section:<n>` codes in the shared table.
  let status =
    step === null
      ? null
      : ruleStatus(CARRIER_ID, `section:${step}`, () => {
          report(step);
        });
  const delivered = status === "delivered";
  if (!delivered && expedition["hasProblem"] === true) {
    status = "problem";
  }
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    direction,
    status,
    rawStatus: step,
    delivered,
    // The app's dates may come without an offset; they are the markets' local (Paris) time.
    deliveredAt: delivered ? isoTime(expedition["tracingDate"], TRACING_TIME) : null,
    sender: text(expedition["brandLabel"]),
    raw: { expedition: { stepSection: step, hasProblem: expedition["hasProblem"] ?? null } },
  });
}

/** Received and shipped lists, each de-duplicated by shipment UID. */
export async function fetchAccountParcels(
  context: PluginContext<unknown, unknown>,
  secret: AccountSecret,
): Promise<FetchResult> {
  const backend = new Backend(context, secret);
  const report = unknownReporter(context, "step");
  const snapshots: ParcelSnapshot[] = [];
  for (const [path, direction] of [
    ["parcels-list-received", "incoming"],
    ["parcels-list-shipped", "outgoing"],
  ] as const) {
    const seen = new Set<string>();
    for (const item of await backend.list(path)) {
      const uid = text(asObject(item["expedition"])["shipmentUid"]);
      if (uid !== null && seen.has(uid)) {
        continue;
      }
      if (uid !== null) {
        seen.add(uid);
      }
      const parcel = accountSnapshot(item, direction, report);
      if (parcel !== null) {
        snapshots.push(parcel);
      }
    }
  }
  return { snapshots, complete: true };
}
