import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asObject,
  num,
  objects,
  readJson,
  SignInRejectedError,
  text,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type Json,
  type PluginContext,
} from "../../plugin/api.js";
import { HONEST_USER_AGENT, OFFICIAL_HOST, TOKEN_MARGIN_MS } from "./keys.js";

/*
 * UPS's official Tracking API (OAuth client credentials), with the user's own developer app.
 * Built from UPS's public developer documentation; not checked against the live API.
 */

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const tokenSchema = z.object({
  /** Which client id the token belongs to; a changed key starts over. */
  base: z.string(),
  accessToken: z.string().min(1),
  expiresAt: z.number(),
});
export type StoredToken = z.infer<typeof tokenSchema>;

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "clock">;

const fingerprint = (credentials: Credentials): string =>
  createHash("sha256").update(credentials.clientId).digest("hex").slice(0, 16);

/** One token request. Only an explicit refusal is a sign-in problem; anything else is transient. */
async function requestToken(deps: Deps, credentials: Credentials): Promise<StoredToken> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );
  const response = await deps.http.request(
    new URL(`https://${OFFICIAL_HOST}/security/v1/oauth/token`),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${basic}`,
        "user-agent": HONEST_USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("UPS refused the developer client id and secret.");
  }
  if (response.status !== 200) {
    throw new TransientError(`UPS's token endpoint answered HTTP ${response.status}.`);
  }
  const body = asObject(readJson(response, "UPS's token endpoint"));
  const accessToken = text(body["access_token"]);
  // `expires_in` is documented as a string of seconds.
  const expiresIn = num(body["expires_in"]);
  if (accessToken === null || expiresIn === null) {
    throw new UnexpectedResponseError("UPS's token response has no token.");
  }
  return {
    base: fingerprint(credentials),
    accessToken,
    expiresAt: deps.clock.now().getTime() + Math.max(0, expiresIn * 1000 - TOKEN_MARGIN_MS),
  };
}

/** The access token of one source: reused while valid, renewed when expired or refused once. */
export class OfficialSession {
  #token: StoredToken | null;

  constructor(
    private readonly deps: Deps,
    private readonly credentials: Credentials,
    stored: StoredToken | null,
  ) {
    this.#token = stored?.base === fingerprint(credentials) ? stored : null;
  }

  /** The token to persist, if one was issued. */
  get token(): StoredToken | null {
    return this.#token;
  }

  async #bearer(): Promise<string> {
    if (this.#token === null || this.deps.clock.now().getTime() >= this.#token.expiresAt) {
      this.#token = await requestToken(this.deps, this.credentials);
    }
    return this.#token.accessToken;
  }

  async #get(code: string): Promise<HttpResponse> {
    const url = new URL(
      `https://${OFFICIAL_HOST}/api/track/v1/details/${encodeURIComponent(code)}`,
    );
    url.searchParams.set("locale", "en_US");
    url.searchParams.set("returnSignature", "false");
    return this.deps.http.request(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await this.#bearer()}`,
        transId: randomUUID().replace(/-/g, ""),
        transactionSrc: "open-parcels",
        "user-agent": HONEST_USER_AGENT,
      },
    });
  }

  /** The package UPS reports for one number; null when it does not know it. */
  async track(code: string): Promise<Json | null> {
    let response = await this.#get(code);
    if (response.status === 401) {
      // UPS refused the token itself: request a new one once. A network error never gets here;
      // it is thrown by the HTTP layer as a transient failure.
      this.#token = null;
      response = await this.#get(code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SignInRejectedError("UPS refused a freshly issued access token.");
    }
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      throw new TransientError(`UPS's Tracking API answered HTTP ${response.status}.`);
    }
    const shipment = objects(
      asObject(asObject(readJson(response, "UPS's Tracking API"))["trackResponse"])["shipment"],
    )[0];
    // An unknown number may also come back as a shipment carrying only warnings.
    return objects(shipment?.["package"])[0] ?? null;
  }
}
