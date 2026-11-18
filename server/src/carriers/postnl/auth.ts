import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { isObject, num, text } from "../../plugin/parse.js";

/**
 * PostNL accounts sign in on PostNL's own login page in the user's browser (OpenID Connect with
 * PKCE). The user pastes the address the browser lands on; its code becomes a refresh token.
 * The password never reaches us, and no captcha is ever touched here.
 */
export const LOGIN_HOST = "login.postnl.nl";
const TENANT = "101112a0-4a0f-4bbb-8176-2f1b2d370d7c";
const BASE = `https://${LOGIN_HOST}/${TENANT}/login`;
const CLIENT_ID = "bd9f1610-b56d-4e05-a09b-f696f05ddade";
const REDIRECT_URI = "https://www.postnl.nl/";
const SCOPE = "openid poa-profiles-api offline_access";
const DEFAULT_LIFETIME_S = 300;
const MARGIN_MS = 60_000;

const signInStateSchema = z.object({ verifier: z.string(), state: z.string() });

export function startSignIn(): { url: string; state: unknown } {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    nonce: randomBytes(24).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state: { verifier, state } };
}

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly lifetimeMs: number;
}

/** One token request. A refused grant is a SignInRejectedError; anything else is transient. */
async function postToken(http: PluginHttp, form: Record<string, string>): Promise<Tokens> {
  const response = await http.request(new URL(`${BASE}/token`), {
    method: "POST",
    redirect: "manual",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
  });
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError(
      `PostNL sign-in answered HTTP ${response.status} without JSON.`,
    );
  }
  const body = isObject(payload) ? payload : {};
  const accessToken = text(body["access_token"]);
  if (response.status === 200 && accessToken !== null) {
    return {
      accessToken,
      refreshToken: text(body["refresh_token"]),
      lifetimeMs: (num(body["expires_in"]) ?? DEFAULT_LIFETIME_S) * 1000,
    };
  }
  const error = text(body["error"]);
  if ((response.status === 400 || response.status === 401) && error === "invalid_grant") {
    throw new SignInRejectedError("PostNL no longer accepts this sign-in; sign in again.");
  }
  throw new TransientError(
    `PostNL sign-in answered HTTP ${response.status} (${error ?? "no error"}).`,
  );
}

export async function finishSignIn(
  http: PluginHttp,
  rawState: unknown,
  pasted: string,
): Promise<{ refreshToken: string }> {
  const expected = signInStateSchema.parse(rawState);
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new SignInRejectedError("Paste the full address the browser ended on.");
  }
  const code = url.searchParams.get("code");
  if (
    url.origin + url.pathname !== REDIRECT_URI ||
    url.searchParams.get("state") !== expected.state ||
    code === null
  ) {
    throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
  }
  const tokens = await postToken(http, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: expected.verifier,
  });
  if (tokens.refreshToken === null) {
    throw new SignInRejectedError("PostNL did not grant offline access.");
  }
  return { refreshToken: tokens.refreshToken };
}

const storedSchema = z.object({
  base: z.string(),
  refreshToken: z.string(),
  accessToken: z.string().nullable(),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;

const fingerprint = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

type SessionDeps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session">;

/** The access token of one account source. A rotated refresh token is saved before use. */
export class PostnlSession {
  #stored: Stored;

  constructor(
    private readonly deps: SessionDeps,
    signedInWith: string,
  ) {
    const parsed = storedSchema.safeParse(deps.session.load());
    const base = fingerprint(signedInWith);
    // A new sign-in replaces whatever an earlier one left behind.
    this.#stored =
      parsed.success && parsed.data.base === base
        ? parsed.data
        : { base, refreshToken: signedInWith, accessToken: null, expiresAt: 0 };
  }

  async accessToken(): Promise<string> {
    const { accessToken, expiresAt } = this.#stored;
    if (accessToken !== null && expiresAt - MARGIN_MS > this.deps.clock.now().getTime()) {
      return accessToken;
    }
    return this.renew();
  }

  /** Refreshes now; used once when PostNL refuses an access token it issued. */
  async renew(): Promise<string> {
    const tokens = await postToken(this.deps.http, {
      grant_type: "refresh_token",
      refresh_token: this.#stored.refreshToken,
    });
    this.#stored = {
      base: this.#stored.base,
      refreshToken: tokens.refreshToken ?? this.#stored.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: this.deps.clock.now().getTime() + tokens.lifetimeMs,
    };
    await this.deps.session.save(this.#stored);
    return tokens.accessToken;
  }
}
