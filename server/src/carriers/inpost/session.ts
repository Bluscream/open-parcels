import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  carrierKey,
  isObject,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type PluginContext,
} from "../../plugin/api.js";
import { CARRIER_ID, SIGN_IN_HOST, text, type Market } from "./shared.js";

type Http = PluginContext<unknown, unknown>["http"];

export const AUTHORIZE_URL = `https://${SIGN_IN_HOST}/oauth2/authorize`;
export const TOKEN_URL = `https://${SIGN_IN_HOST}/oauth2/token`;
export const REDIRECT_URI = `https://${SIGN_IN_HOST}/callback`;
/** The public client of InPost's own sign-in (in the shared rules); PKCE, no client secret. */
export const clientId = (): string => carrierKey(CARRIER_ID, "client_id");

const signInStateSchema = z.object({
  verifier: z.string(),
  state: z.string(),
  market: z.enum(["PL", "IT"]),
});

const storedSchema = z.object({
  base: z.string(),
  accessToken: z.string().nullable(),
  refreshToken: z.string(),
});
type Stored = z.infer<typeof storedSchema>;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The sign-in page in the market's language when the user's language matches, else English. */
function signInLanguage(market: Market, language: string | undefined): string {
  const local = market === "PL" ? "pl-PL" : "it-IT";
  return language?.toLowerCase().startsWith(local.slice(0, 2)) === true ? local : "en";
}

/**
 * Step 1: InPost's login page needs a captcha, so the user signs in in their own browser and
 * pastes back the callback address it ends on. A fresh verifier, state and nonce every time.
 */
export function startSignIn(market: Market, language?: string): { url: string; state: unknown } {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL(AUTHORIZE_URL);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId(),
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    nonce: randomBytes(24).toString("base64url"),
    response_mode: "query",
    lang: signInLanguage(market, language),
    supported_markets: market,
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString(), state: { verifier, state, market } };
}

/** Unverified read of a JWT's claims; only used to check the account's market at sign-in. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

/**
 * One token request. HTTP 400 or 401 is the sign-in refusing the code or refresh token;
 * anything else, network errors included, is transient and never leads to a new sign-in.
 */
async function postToken(http: Http, form: Record<string, string>): Promise<Tokens> {
  const response = await http.request(new URL(TOKEN_URL), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId(), ...form }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new SignInRejectedError(`InPost refused the sign-in (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`InPost's token endpoint answered HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new UnexpectedResponseError("InPost's token endpoint did not answer with JSON.");
  }
  const accessToken = isObject(body) ? text(body["access_token"]) : null;
  if (!isObject(body) || accessToken === null) {
    throw new UnexpectedResponseError("InPost's token response has no access token.");
  }
  return { accessToken, refreshToken: text(body["refresh_token"]) };
}

export interface InPostSecret {
  readonly refreshToken: string;
  readonly market: Market;
}

/** Step 2: checks the pasted callback address and exchanges its code for a refresh token. */
export async function finishSignIn(
  http: Http,
  rawState: unknown,
  pasted: string,
): Promise<InPostSecret> {
  const expected = signInStateSchema.parse(rawState);
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new SignInRejectedError("The pasted text is not an address.");
  }
  const code = url.searchParams.get("code");
  if (
    url.protocol !== "https:" ||
    `${url.origin}${url.pathname}` !== REDIRECT_URI ||
    url.searchParams.get("state") !== expected.state ||
    code === null
  ) {
    throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
  }
  const tokens = await postToken(http, {
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: expected.verifier,
    code,
  });
  if (tokens.refreshToken === null) {
    throw new SignInRejectedError("InPost did not grant a refresh token.");
  }
  const market = text(tokenClaims(tokens.accessToken)?.["market"]);
  if (market !== null && market.toUpperCase() !== expected.market) {
    throw new SignInRejectedError(
      `This InPost account belongs to the ${market.toUpperCase()} market, not ${expected.market}.`,
    );
  }
  return { refreshToken: tokens.refreshToken, market: expected.market };
}

type SessionDeps = Pick<PluginContext<unknown, unknown>, "http" | "session">;

/** The access token of one account source; a rotated refresh token is saved before use. */
export class InPostSession {
  #stored: Stored;

  constructor(
    private readonly deps: SessionDeps,
    signedInWith: string,
  ) {
    const parsed = storedSchema.safeParse(deps.session.load());
    const base = fingerprint(signedInWith);
    this.#stored =
      parsed.success && parsed.data.base === base
        ? parsed.data
        : { base, accessToken: null, refreshToken: signedInWith };
  }

  async accessToken(): Promise<string> {
    return this.#stored.accessToken ?? this.refresh();
  }

  /** Renews the access token. Called once after InPost refused one; callers never loop on it. */
  async refresh(): Promise<string> {
    const tokens = await postToken(this.deps.http, {
      grant_type: "refresh_token",
      refresh_token: this.#stored.refreshToken,
    });
    this.#stored = {
      ...this.#stored,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? this.#stored.refreshToken,
    };
    await this.deps.session.save(this.#stored);
    return tokens.accessToken;
  }
}
