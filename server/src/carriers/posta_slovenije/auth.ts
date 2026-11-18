import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type SessionStore,
} from "../../plugin/api.js";
import type { Clock } from "../../clock.js";
import type { PluginHttp } from "../../plugin/http.js";
import { isObject, num, text } from "../../plugin/parse.js";
import { AUTH_HOST } from "./shared.js";

/**
 * MojaPošta signs in with an OpenID Connect password grant on the app's public client id. No
 * client secret exists or is used; the user's own username and password are the credentials.
 */
const TOKEN_URL = new URL(`https://${AUTH_HOST}/realms/mojaposta/protocol/openid-connect/token`);
const CLIENT_ID = "mojaposta-ios";
const SCOPE = "openid profile email offline_access";
const DEFAULT_LIFETIME_S = 300;
const MARGIN_MS = 60_000;

export const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.number(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

interface TokenAnswer {
  readonly status: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

async function postToken(http: PluginHttp, form: Record<string, string>): Promise<TokenAnswer> {
  const response = await http.request(TOKEN_URL, {
    method: "POST",
    redirect: "manual",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError(
      `MojaPošta sign-in answered HTTP ${response.status} without JSON.`,
    );
  }
  return { status: response.status, payload: isObject(payload) ? payload : {} };
}

function readTokens(answer: TokenAnswer, clock: Clock, previousRefresh: string | null): Tokens {
  const accessToken = text(answer.payload["access_token"]);
  if (accessToken === null) {
    throw new UnexpectedResponseError("MojaPošta sign-in returned no access token.");
  }
  const lifetime = num(answer.payload["expires_in"]) ?? DEFAULT_LIFETIME_S;
  return {
    accessToken,
    refreshToken: text(answer.payload["refresh_token"]) ?? previousRefresh,
    expiresAt: clock.now().getTime() + lifetime * 1000,
  };
}

const errorOf = (answer: TokenAnswer): string | null => text(answer.payload["error"]);

/** Signs in with the password. A rejected password is the only SignInRejectedError here. */
export async function passwordGrant(
  http: PluginHttp,
  clock: Clock,
  credentials: Credentials,
): Promise<Tokens> {
  let scope = SCOPE;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await postToken(http, {
      grant_type: "password",
      client_id: CLIENT_ID,
      username: credentials.username,
      password: credentials.password,
      scope,
    });
    if (answer.status === 200) {
      return readTokens(answer, clock, null);
    }
    const error = errorOf(answer);
    const description = (text(answer.payload["error_description"]) ?? "").toLowerCase();
    if (
      (answer.status === 400 || answer.status === 401) &&
      error === "invalid_grant" &&
      description.includes("credentials")
    ) {
      throw new SignInRejectedError("MojaPošta rejected the username or password.");
    }
    if (error !== "invalid_scope" || !scope.includes("offline_access")) {
      throw new TransientError(
        `MojaPošta sign-in answered HTTP ${answer.status} (${error ?? "no error"}).`,
      );
    }
    scope = scope.replace(" offline_access", "");
  }
  throw new TransientError("MojaPošta sign-in refused every scope.");
}

/** Renews with the refresh token; null when MojaPošta no longer accepts it. */
async function refreshGrant(
  http: PluginHttp,
  clock: Clock,
  refreshToken: string,
): Promise<Tokens | null> {
  const answer = await postToken(http, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (answer.status === 200) {
    return readTokens(answer, clock, refreshToken);
  }
  if ((answer.status === 400 || answer.status === 401) && errorOf(answer) === "invalid_grant") {
    return null;
  }
  throw new TransientError(`MojaPošta token refresh answered HTTP ${answer.status}.`);
}

/** Holds the token pair for one run and saves every renewal. */
export class TokenKeeper {
  #tokens: Tokens | null;

  constructor(
    private readonly http: PluginHttp,
    private readonly clock: Clock,
    private readonly session: SessionStore,
    private readonly credentials: Credentials,
  ) {
    const stored = tokensSchema.safeParse(session.load());
    this.#tokens = stored.success ? stored.data : null;
  }

  /** A token that is not about to expire, renewing it first if needed. */
  async current(): Promise<string> {
    const tokens = this.#tokens;
    if (tokens !== null && tokens.expiresAt - MARGIN_MS > this.clock.now().getTime()) {
      return tokens.accessToken;
    }
    return this.renew(true);
  }

  /** Renews after MojaPošta refused a token: refresh first when asked, else the password. */
  async renew(tryRefresh: boolean): Promise<string> {
    const refreshToken = this.#tokens?.refreshToken ?? null;
    let tokens =
      tryRefresh && refreshToken !== null
        ? await refreshGrant(this.http, this.clock, refreshToken)
        : null;
    tokens ??= await passwordGrant(this.http, this.clock, this.credentials);
    this.#tokens = tokens;
    await this.session.save(tokens);
    return tokens.accessToken;
  }
}
