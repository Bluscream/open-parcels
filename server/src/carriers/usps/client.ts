import type { PluginHttp } from "../../plugin/http.js";
import {
  SignInRejectedError,
  UnexpectedResponseError,
  type PluginLogger,
  type SessionStore,
} from "../../plugin/api.js";
import { expectStatus, isObject, readJson, text, type Json } from "../../plugin/payload.js";

export const API_HOST = "apis.usps.com";

export interface Credentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

/** The cached access token. It is renewed from the stored key pair, never from user input. */
interface Token {
  readonly accessToken: string;
  readonly expiresAt: number;
}

function storedToken(value: unknown): Token | null {
  if (!isObject(value)) {
    return null;
  }
  const accessToken = text(value["accessToken"]);
  const expiresAt = value["expiresAt"];
  return accessToken !== null && typeof expiresAt === "number" ? { accessToken, expiresAt } : null;
}

/**
 * USPS' Tracking API with an OAuth client-credentials token. A refused key pair, or one without
 * the tracking scope, is a sign-in problem; a network error never leads to a new token.
 */
export class UspsClient {
  constructor(
    private readonly http: PluginHttp,
    private readonly session: SessionStore,
    private readonly credentials: Credentials,
    private readonly now: () => number,
    private readonly logger: PluginLogger,
  ) {}

  async #token(force: boolean): Promise<string> {
    const cached = storedToken(this.session.load());
    if (!force && cached !== null && this.now() < cached.expiresAt) {
      return cached.accessToken;
    }
    const response = await this.http.request(new URL(`https://${API_HOST}/oauth2/v3/token`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.credentials.consumerKey,
        client_secret: this.credentials.consumerSecret,
        grant_type: "client_credentials",
      }),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new SignInRejectedError(`USPS refused the consumer key (HTTP ${response.status}).`);
    }
    expectStatus(response, "USPS", 200);
    const payload = readJson(response, "USPS");
    const accessToken = isObject(payload) ? text(payload["access_token"]) : null;
    if (!isObject(payload) || accessToken === null) {
      throw new UnexpectedResponseError("USPS answered the token request without a token.");
    }
    const scope = text(payload["scope"]);
    if (scope !== null && !scope.toLowerCase().split(/\s+/).includes("tracking")) {
      throw new SignInRejectedError(
        "This USPS consumer key does not have the Tracking API enabled.",
      );
    }
    const lifetime = typeof payload["expires_in"] === "number" ? payload["expires_in"] : 0;
    const token: Token = { accessToken, expiresAt: this.now() + Math.max(0, lifetime - 60) * 1000 };
    await this.session.save(token);
    this.logger.debug({}, "USPS issued a new access token.");
    return accessToken;
  }

  /** One parcel's detail payload, or null when USPS does not know the number. */
  async parcel(barcode: string): Promise<Json | null> {
    const url = new URL(`https://${API_HOST}/tracking/v3/tracking/${encodeURIComponent(barcode)}`);
    url.searchParams.set("expand", "DETAIL");
    for (const force of [false, true]) {
      const token = await this.#token(force);
      const response = await this.http.request(url, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      if (response.status === 401 && !force) {
        // The token was refused outright; renewing it once from the stored key pair is fine.
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new SignInRejectedError(
          `USPS refused the tracking request (HTTP ${response.status}).`,
        );
      }
      if (response.status === 404) {
        return null;
      }
      expectStatus(response, "USPS", 200);
      const payload = readJson(response, "USPS");
      if (!isObject(payload)) {
        throw new UnexpectedResponseError("USPS did not answer with a tracking object.");
      }
      return payload;
    }
    throw new SignInRejectedError("USPS refused a freshly issued token.");
  }
}
