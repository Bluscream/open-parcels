import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type PluginContext,
  type PluginHttp,
  asObject,
  num,
  parseJsonBody,
  text,
} from "../../plugin/api.js";

export const AUTH_HOST = "auth.dao.as";
export const API_HOST = "apiv2.dao.as";
const REALM = `https://${AUTH_HOST}/realms/consumers/protocol/openid-connect`;
/**
 * DAO's app signs in as a public client: no secret, PKCE only, and a redirect to the app's own
 * scheme. The user signs in in their own browser and pastes that final address back.
 */
const CLIENT_ID = "dao-app";
const REDIRECT_URI = "daoapp://auth-callback";
const DEFAULT_LIFETIME_S = 300;
const MARGIN_MS = 120_000;

const base64Url = (bytes: Buffer): string => bytes.toString("base64url");
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const signInStateSchema = z.object({ verifier: z.string(), state: z.string() });

/** Step 1: the sign-in address with a fresh PKCE verifier and state. */
export function startSignIn(): { url: string; state: unknown } {
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(24));
  const url = new URL(`${REALM}/auth`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    state,
    code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    ui_locales: "da",
  }).toString();
  return { url: url.toString(), state: { verifier, state } };
}

interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly lifetimeMs: number;
}

/** Only an explicit refusal of the grant or client is a sign-in problem; the rest is transient. */
async function postToken(http: PluginHttp, form: Record<string, string>): Promise<Tokens> {
  const response = await http.request(new URL(`${REALM}/token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...form }),
  });
  // A non-JSON answer is never a refusal: it reads as an empty object and is handled below.
  const body: Record<string, unknown> = asObject(parseJsonBody(response.body));
  const error = text(body["error"]);
  if (
    (response.status === 400 || response.status === 401) &&
    (error === "invalid_grant" || error === "invalid_client" || error === "unauthorized_client")
  ) {
    throw new SignInRejectedError(`DAO refused the sign-in (${error}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`DAO's token endpoint answered HTTP ${response.status}.`);
  }
  const accessToken = text(body["access_token"]);
  const refreshToken = text(body["refresh_token"]);
  if (accessToken === null || refreshToken === null) {
    throw new UnexpectedResponseError("DAO's token response is missing a token.");
  }
  return {
    accessToken,
    refreshToken,
    lifetimeMs: (num(body["expires_in"]) ?? DEFAULT_LIFETIME_S) * 1000,
  };
}

/** Step 2: exchange the code from the pasted `daoapp://` address for a refresh token. */
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
    throw new SignInRejectedError("The pasted text is not an address.");
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== expected.state || code === null) {
    throw new SignInRejectedError("The pasted address does not belong to this sign-in.");
  }
  const tokens = await postToken(http, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: expected.verifier,
  });
  return { refreshToken: tokens.refreshToken };
}

const storedSchema = z.object({
  base: z.string(),
  refreshToken: z.string().min(1),
  accessToken: z.string().nullable(),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session">;

/**
 * The bearer session of one account. DAO rotates refresh tokens, so the newest one is saved
 * before anything else is sent. A refused bearer is renewed once; a refused renewal, or a bearer
 * refused right after renewal, means the user has to sign in again.
 */
export class DaoSession {
  #stored: Stored;

  constructor(
    private readonly deps: Deps,
    signedInWith: string,
  ) {
    const parsed = storedSchema.safeParse(deps.session.load());
    const base = fingerprint(signedInWith);
    this.#stored =
      parsed.success && parsed.data.base === base
        ? parsed.data
        : { base, refreshToken: signedInWith, accessToken: null, expiresAt: 0 };
  }

  async #renew(): Promise<string> {
    const tokens = await postToken(this.deps.http, {
      grant_type: "refresh_token",
      refresh_token: this.#stored.refreshToken,
    });
    this.#stored = {
      ...this.#stored,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: this.deps.clock.now().getTime() + tokens.lifetimeMs,
    };
    await this.deps.session.save(this.#stored);
    return tokens.accessToken;
  }

  async #bearer(): Promise<string> {
    const { accessToken, expiresAt } = this.#stored;
    return accessToken !== null && this.deps.clock.now().getTime() < expiresAt - MARGIN_MS
      ? accessToken
      : this.#renew();
  }

  /** One authenticated GET; anything but 200 after at most one renewal is an error. */
  async get(path: string, query: Record<string, string> = {}): Promise<HttpResponse> {
    const url = new URL(`https://${API_HOST}${path}`);
    url.search = new URLSearchParams(query).toString();
    const send = async (token: string): Promise<HttpResponse> =>
      this.deps.http.request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
    let response = await send(await this.#bearer());
    if (response.status === 401) {
      response = await send(await this.#renew());
      if (response.status === 401) {
        throw new SignInRejectedError("DAO refused a freshly renewed session.");
      }
    }
    if (response.status !== 200) {
      throw new TransientError(`DAO ${path} answered HTTP ${response.status}.`);
    }
    return response;
  }
}
