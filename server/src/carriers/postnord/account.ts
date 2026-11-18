import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  isObject,
  num,
  parseJsonBody,
  pastedRedirect,
  SignInRejectedError,
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
import { CARRIER_ID, shipmentSnapshot } from "./parcel.js";

export const ACCOUNT_HOST = "account.postnord.com";
const GATEWAY = "https://api2.postnord.com/rest/customer/v2/receiverapp/tracking";
const REDIRECT_URI = "com.postnord.app://redirect";
const SCOPES = [
  "openid",
  "offline_access",
  "https://api.postnord.com/scopes/shipment/eventsorterservice/recipient",
  "https://api.postnord.com/scopes/receiverapp-bff/track",
  "https://api.postnord.com/scopes/trackedshipments/track",
  "https://api.postnord.com/scopes/recipientinstructions/read",
  "https://api.postnord.com/scopes/eta/livetracking",
  "https://api.postnord.com/scopes/preferences/recipient",
];
const MARGIN_MS = 60_000;

export interface AccountSecret {
  readonly refreshToken: string;
}

const clientId = (): string => carrierKey(CARRIER_ID, "receiver_app_client_id");

/** Only an explicit 4xx refusal of a grant is a sign-in problem; a 5xx or network error is not. */
async function postToken(http: PluginHttp, form: Record<string, string>) {
  const response = await http.request(new URL(`https://${ACCOUNT_HOST}/oauth2/token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  if (response.status >= 500 || response.status === 429) {
    throw new TransientError(`PostNord's token endpoint answered HTTP ${response.status}.`);
  }
  const body = asObject(parseJsonBody(response.body));
  const access = text(body["access_token"]);
  if (response.status !== 200 || access === null) {
    throw new SignInRejectedError("PostNord refused the sign-in; sign in again.");
  }
  return {
    access,
    refresh: text(body["refresh_token"]),
    lifetimeMs: (num(body["expires_in"]) ?? 900) * 1000,
  };
}

const flowState = z.object({ verifier: z.string(), state: z.string() });

/**
 * The receiver app's sign-in: a public native client with PKCE whose only redirect is the app's
 * own scheme, so the user pastes that final `com.postnord.app://` address back (also accepted
 * with a `Location:` label or quotes, as copied from a network panel).
 */
export function accountSignIn<Config>(): InteractiveSignIn<Config, AccountSecret> {
  return pastedRedirect<Config, AccountSecret>({
    id: "account",
    label: "PostNord account (sign in in your browser)",
    kinds: ["account"],
    start: () => {
      const verifier = randomBytes(64).toString("base64url");
      const state = randomBytes(16).toString("base64url");
      const url = new URL(`https://${ACCOUNT_HOST}/auth`);
      url.search = new URLSearchParams({
        client_id: clientId(),
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(" "),
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
      }).toString();
      return Promise.resolve({ url: url.toString(), state: { verifier, state } });
    },
    finish: async (context, raw, pasted) => {
      const expected = flowState.parse(raw);
      let value = pasted.trim().replace(/^["']|["']$/g, "");
      if (value.toLowerCase().startsWith("location:")) {
        value = value
          .slice("location:".length)
          .trim()
          .replace(/^["']|["']$/g, "");
      }
      const url = URL.canParse(value) ? new URL(value) : null;
      const code = url?.searchParams.get("code") ?? null;
      if (
        url === null ||
        !value.startsWith(REDIRECT_URI) ||
        code === null ||
        url.searchParams.get("state") !== expected.state
      ) {
        throw new SignInRejectedError("The pasted address is not this sign-in's redirect.");
      }
      const tokens = await postToken(context.http, {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: expected.verifier,
      });
      if (tokens.refresh === null) {
        throw new UnexpectedResponseError("PostNord granted no refresh token.");
      }
      return { refreshToken: tokens.refresh };
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

async function readInbox(
  context: PluginContext<unknown, unknown>,
  secret: AccountSecret,
): Promise<Json> {
  const parsed = storedSchema.safeParse(context.session.load());
  const base = fingerprint(secret.refreshToken);
  let stored: Stored =
    parsed.success && parsed.data.base === base
      ? parsed.data
      : { base, refreshToken: secret.refreshToken, accessToken: null, expiresAt: 0 };
  const renew = async (): Promise<string> => {
    const tokens = await postToken(context.http, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    stored = {
      ...stored,
      refreshToken: tokens.refresh ?? stored.refreshToken,
      accessToken: tokens.access,
      expiresAt: context.clock.now().getTime() + tokens.lifetimeMs,
    };
    await context.session.save(stored);
    return tokens.access;
  };
  const url = new URL(GATEWAY);
  url.search = new URLSearchParams({
    summary: "false",
    apikey: carrierKey(CARRIER_ID, "receiver_app_key"),
  }).toString();
  const send = async (token: string): Promise<HttpResponse> =>
    context.http.request(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "accept-language": "en",
        context: "mobileapp",
      },
    });
  const fresh =
    stored.accessToken !== null && context.clock.now().getTime() < stored.expiresAt - MARGIN_MS;
  let response = await send(
    fresh && stored.accessToken !== null ? stored.accessToken : await renew(),
  );
  if (response.status === 401 || response.status === 403) {
    response = await send(await renew());
    if (response.status === 401 || response.status === 403) {
      // A just-renewed token refused: the app's gateway key was rotated, not the user's sign-in.
      throw new TransientError("PostNord's gateway refused the app key.");
    }
  }
  if (response.status !== 200) {
    throw new TransientError(`PostNord's account answered HTTP ${response.status}.`);
  }
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("PostNord's account answered without a JSON object.");
  }
  return payload;
}

/** Active and archived shipments; a missing bucket is a changed answer, never an empty inbox. */
export async function fetchPostnordAccount(
  context: PluginContext<unknown, unknown>,
  secret: AccountSecret,
): Promise<FetchResult> {
  const payload = await readInbox(context, secret);
  const report = unknownReporter(context, "status_code");
  const snapshots: ParcelSnapshot[] = [];
  for (const bucket of ["activeShipments", "archivedShipments"]) {
    if (!Array.isArray(payload[bucket])) {
      throw new UnexpectedResponseError(`PostNord's account answered without ${bucket}.`);
    }
    for (const raw of asList(payload[bucket]).filter(isObject)) {
      const item = asObject(asList(raw["items"])[0]);
      const code = text(raw["shipmentId"]) ?? text(item["itemId"]);
      if (code === null) {
        continue;
      }
      // The account puts statusText on the item; the shared mapping reads it from the shipment.
      const shaped = {
        ...raw,
        statusText: raw["statusText"] ?? item["statusText"],
        status: raw["status"] ?? item["status"],
      };
      const parcel = shipmentSnapshot(shaped, code, report);
      const outgoing = asObject(raw["userData"])["direction"] === "OUTGOING";
      snapshots.push({ ...parcel, direction: outgoing ? "outgoing" : "incoming" });
    }
  }
  return { snapshots, complete: true };
}
