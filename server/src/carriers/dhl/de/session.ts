import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type PluginContext,
  num,
  parseJsonBody,
} from "../../../plugin/api.js";
import {
  DE_ACCOUNT_CLAIM,
  DE_AUTHORIZE_URL,
  DE_CLIENT_ID,
  DE_DISCOVERY_URL,
  DE_LOGIN_CLAIMS,
  DE_REDIRECT_URI,
  DE_SCOPE,
  DE_TOKEN_HEADERS,
  DE_TOKEN_LIFETIME_MS,
  DE_TOKEN_MARGIN_MS,
} from "../constants.js";
import { asObject, asString } from "../util.js";

type Http = PluginContext<unknown, unknown>["http"];

const signInStateSchema = z.object({ verifier: z.string(), state: z.string() });

/** What the session store keeps between runs. `base` ties it to the refresh token signed in with. */
const storedSchema = z.object({
  base: z.string(),
  refreshToken: z.string(),
  idToken: z.string().nullable(),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Step 1 of the sign-in: a fresh PKCE verifier, state and nonce for every attempt. */
export function startSignIn(): { url: string; state: unknown } {
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(24));
  const url = new URL(DE_AUTHORIZE_URL);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: DE_CLIENT_ID,
    redirect_uri: DE_REDIRECT_URI,
    scope: DE_SCOPE,
    claims: DE_LOGIN_CLAIMS,
    code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    nonce: base64Url(randomBytes(24)),
    prompt: "login",
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return { url: url.toString(), state: { verifier, state } };
}

/** Unverified read of a JWT's claims; only used to check that the account claim is present. */
export function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const payload = idToken.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  return asObject(parseJsonBody(Buffer.from(payload, "base64url").toString("utf8")));
}

async function tokenEndpoint(http: Http): Promise<URL> {
  const response = await http.request(new URL(DE_DISCOVERY_URL), {
    headers: { accept: "application/json" },
  });
  if (response.status !== 200) {
    throw new TransientError(`DHL's sign-in discovery answered HTTP ${response.status}.`);
  }
  const endpoint = asString(asObject(parseJsonBody(response.body))?.["token_endpoint"]);
  if (endpoint === null) {
    throw new UnexpectedResponseError("DHL's sign-in discovery has no token endpoint.");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.hostname !== "login.dhl.de") {
    throw new UnexpectedResponseError("DHL's token endpoint is not on login.dhl.de.");
  }
  return url;
}

interface Tokens {
  readonly idToken: string;
  readonly refreshToken: string | null;
  readonly lifetimeMs: number;
}

/**
 * One token request. Only an explicit refusal of the grant or the client is a sign-in problem;
 * everything else, including network errors, is transient and never leads to a new sign-in.
 */
async function postToken(http: Http, form: Record<string, string>): Promise<Tokens> {
  const response = await http.request(await tokenEndpoint(http), {
    method: "POST",
    headers: {
      ...DE_TOKEN_HEADERS,
      authorization: `Basic ${Buffer.from(`${DE_CLIENT_ID}:`).toString("base64")}`,
    },
    body: new URLSearchParams({ redirect_uri: DE_REDIRECT_URI, ...form }),
  });
  const body = asObject(parseJsonBody(response.body));
  const error = asString(body?.["error"]);
  if (
    (response.status === 400 || response.status === 401) &&
    (error === "invalid_grant" || error === "unauthorized_client" || error === "invalid_client")
  ) {
    throw new SignInRejectedError(`DHL refused the sign-in (${error}).`);
  }
  if (response.status !== 200 || body === null) {
    throw new TransientError(`DHL's token endpoint answered HTTP ${response.status}.`);
  }
  const idToken = asString(body["id_token"]);
  if (idToken === null) {
    throw new UnexpectedResponseError("DHL's token response has no ID token.");
  }
  if (!(DE_ACCOUNT_CLAIM in (idTokenClaims(idToken) ?? {}))) {
    // The token still authenticates, but the inbox is empty without the account link.
    throw new SignInRejectedError("DHL's ID token is no longer linked to the account.");
  }
  const expiresIn = num(body["expires_in"], { strings: false });
  return {
    idToken,
    refreshToken: asString(body["refresh_token"]),
    lifetimeMs: expiresIn === null ? DE_TOKEN_LIFETIME_MS : expiresIn * 1000,
  };
}

/** Step 2: exchange the code from the pasted `dhllogin://` address for a refresh token. */
export async function finishSignIn(
  http: Http,
  rawState: unknown,
  pasted: string,
): Promise<{ refreshToken: string }> {
  const expected = signInStateSchema.parse(rawState);
  const url = new URL(pasted.trim());
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== expected.state || code === null) {
    throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
  }
  const tokens = await postToken(http, {
    grant_type: "authorization_code",
    code,
    code_verifier: expected.verifier,
  });
  if (tokens.refreshToken === null) {
    throw new SignInRejectedError("DHL did not grant offline access.");
  }
  return { refreshToken: tokens.refreshToken };
}

type SessionDeps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session">;

/**
 * The ID token lifecycle of one account source. Tokens are refreshed shortly before they
 * expire; a rotated refresh token is saved before it is used for anything else.
 */
export class DeSession {
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
        : { base, refreshToken: signedInWith, idToken: null, expiresAt: 0 };
  }

  async idToken(): Promise<string> {
    const { idToken, expiresAt } = this.#stored;
    if (idToken !== null && this.deps.clock.now().getTime() < expiresAt - DE_TOKEN_MARGIN_MS) {
      return idToken;
    }
    return this.refresh();
  }

  /** Renews the ID token. Called once after DHL refused one; callers never loop on it. */
  async refresh(): Promise<string> {
    const tokens = await postToken(this.deps.http, {
      grant_type: "refresh_token",
      refresh_token: this.#stored.refreshToken,
    });
    this.#stored = {
      ...this.#stored,
      refreshToken: tokens.refreshToken ?? this.#stored.refreshToken,
      idToken: tokens.idToken,
      expiresAt: this.deps.clock.now().getTime() + tokens.lifetimeMs,
    };
    await this.deps.session.save(this.#stored);
    return tokens.idToken;
  }
}
