import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asObject,
  carrierKey,
  isOAuthRefusal,
  isObject,
  isoTime,
  mayHaveMorePages,
  num,
  parseJsonBody,
  pastedRedirect,
  requiredList,
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
  rulesTrackingUrl,
} from "../../plugin/api.js";
import { CARRIER_ID } from "./parse.js";

export const LOGIN_HOST = "login.swissid.ch";
export const APP_HOST = "app.post.ch";
const REDIRECT_URI = `https://${APP_HOST}/mainapp/auth/callback`;
const SCOPE = "openid profile email address phone";
const MARGIN_MS = 120_000;

export interface AccountSecret {
  readonly refreshToken: string;
  readonly deviceId: string;
}

/** The Post app's public OAuth client (in the shared rules); it has no secret. */
const clientId = (): string => carrierKey(CARRIER_ID, "app_client_id");

async function postToken(http: PluginHttp, form: Record<string, string>) {
  const response = await http.request(new URL(`https://${LOGIN_HOST}/idp/oauth2/access_token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  if (isOAuthRefusal(response)) {
    throw new SignInRejectedError("SwissID refused the sign-in; sign in again.");
  }
  if (response.status === 400 || response.status === 401) {
    throw new UnexpectedResponseError(
      `SwissID's token endpoint answered HTTP ${response.status} without an OAuth error.`,
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`SwissID's token endpoint answered HTTP ${response.status}.`);
  }
  const body = asObject(parseJsonBody(response.body));
  const idToken = text(body["id_token"]);
  const refresh = text(body["refresh_token"]);
  if (idToken === null || refresh === null) {
    throw new UnexpectedResponseError("SwissID's token answer is missing a token.");
  }
  return { idToken, refresh };
}

/** The unverified `exp` of a JWT, in milliseconds; only used to time the next refresh. */
function expiresAt(jwt: string): number {
  const claims = asObject(
    parseJsonBody(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()),
  );
  return (num(claims["exp"]) ?? 0) * 1000;
}

const flowState = z.object({ verifier: z.string(), state: z.string() });

/**
 * SwissID's browser sign-in (PKCE, may ask for a second factor). Its redirect opens the Post app,
 * so the user pastes the `app.post.ch/mainapp/auth/callback` address back.
 */
export function accountSignIn<Config>(): InteractiveSignIn<Config, AccountSecret> {
  return pastedRedirect<Config, AccountSecret>({
    id: "account",
    label: "Swiss Post account (SwissID, in your browser)",
    kinds: ["account"],
    start: () => {
      const verifier = randomBytes(48).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const url = new URL(`https://${LOGIN_HOST}/idp/oauth2/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId(),
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        prompt: "login",
      }).toString();
      return Promise.resolve({ url: url.toString(), state: { verifier, state } });
    },
    finish: async (context, raw, pasted) => {
      const expected = flowState.parse(raw);
      const value = pasted.trim();
      const url = URL.canParse(value) ? new URL(value) : null;
      const code = url?.searchParams.get("code") ?? null;
      if (
        url === null ||
        `${url.origin}${url.pathname}` !== REDIRECT_URI ||
        code === null ||
        url.searchParams.get("state") !== expected.state
      ) {
        throw new SignInRejectedError("The pasted address is not this sign-in's callback.");
      }
      const tokens = await postToken(context.http, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: expected.verifier,
      });
      return { refreshToken: tokens.refresh, deviceId: randomUUID() };
    },
  });
}

const storedSchema = z.object({
  base: z.string(),
  refreshToken: z.string().min(1),
  idToken: z.string().nullable(),
});
type Stored = z.infer<typeof storedSchema>;
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * The inbox accepts the JWT id token (one hour), not the access token. Refresh tokens rotate and
 * are saved before the inbox is called; a refused refresh means signing in again.
 */
async function overview(
  context: PluginContext<unknown, unknown>,
  secret: AccountSecret,
): Promise<Json> {
  const parsed = storedSchema.safeParse(context.session.load());
  const base = fingerprint(secret.refreshToken);
  let stored: Stored =
    parsed.success && parsed.data.base === base
      ? parsed.data
      : { base, refreshToken: secret.refreshToken, idToken: null };
  const renew = async (): Promise<string> => {
    const tokens = await postToken(context.http, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      scope: SCOPE,
    });
    stored = { base, refreshToken: tokens.refresh, idToken: tokens.idToken };
    await context.session.save(stored);
    return tokens.idToken;
  };
  const send = async (token: string): Promise<HttpResponse> =>
    context.http.request(new URL(`https://${APP_HOST}/mobserv/v1/mailpiece/tracking/overview`), {
      headers: {
        authorization: `Bearer ${token}`,
        "x-device-id": secret.deviceId,
        accept: "application/json",
      },
    });
  const current = stored.idToken;
  const fresh = current !== null && context.clock.now().getTime() < expiresAt(current) - MARGIN_MS;
  // At most one renewal per run: a token renewed for its age is not renewed again after a 401.
  let response = await send(fresh ? current : await renew());
  if ((response.status === 401 || response.status === 403) && fresh) {
    response = await send(await renew());
  }
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("Swiss Post refused a freshly renewed session.");
  }
  if (response.status !== 200) {
    throw new TransientError(`Swiss Post's inbox answered HTTP ${response.status}.`);
  }
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("Swiss Post's inbox answered without a JSON object.");
  }
  return payload;
}

const epochTime = (value: unknown): string | null => isoTime(value, { naive: "utc", epoch: "ms" });

export function accountSnapshot(raw: Json, report: (key: string) => void): ParcelSnapshot | null {
  const barcode = text(raw["mailpieceId"]);
  if (barcode === null || text(raw["mailpieceType"])?.toUpperCase() === "LETTER") {
    return null;
  }
  const code = text(raw["mailpieceStatusType"]);
  // The app's own enum, as `account:<value>` codes in the shared table.
  const status =
    code === null
      ? null
      : ruleStatus(CARRIER_ID, `account:${code}`, () => {
          report(code);
        });
  const delivered = status === "delivered";
  const pickup = status === "at_pickup_point";
  const address = asObject(raw["deliveryAddress"]);
  const range = asObject(address["timeRange"]);
  const from = epochTime(range["from"]);
  const to = epochTime(range["to"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    direction: raw["userIsSender"] === true ? "outgoing" : "incoming",
    status,
    rawStatus: code,
    delivered,
    deliveredAt: delivered ? epochTime(raw["statusTimestamp"]) : null,
    plannedFrom: delivered || pickup ? null : from,
    plannedTo: delivered || pickup || to === from ? null : to,
    pickup,
    pickupPoint: pickup ? text(asObject(address["pickupOffice"])["name"]) : null,
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    sender: text(raw["summaryDescription"]),
    raw: { mailpieceStatusType: code, userIsSender: raw["userIsSender"] ?? null },
  });
}

export async function fetchSwissPostAccount(
  context: PluginContext<unknown, unknown>,
  secret: AccountSecret,
): Promise<FetchResult> {
  const payload = await overview(context, secret);
  const report = unknownReporter(context, "status_code");
  // Both lists must be there: a renamed key or an error object sent with HTTP 200 would otherwise
  // read as an empty account and mark every parcel gone.
  const entries = ["inProgress", "completed"].flatMap((key) =>
    requiredList(payload, key, "Swiss Post's inbox"),
  );
  let complete = true;
  const snapshots: ParcelSnapshot[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) {
      complete = false;
      continue;
    }
    const parcel = accountSnapshot(entry, report);
    if (parcel !== null) {
      snapshots.push(parcel);
    } else if (text(entry["mailpieceType"])?.toUpperCase() !== "LETTER") {
      // A parcel without its id is skipped, so the list is no longer everything.
      complete = false;
    }
  }
  // The overview's paging is not documented: one that says it holds more is not everything.
  return { snapshots, complete: complete && !mayHaveMorePages(payload, entries.length) };
}
