import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type PluginContext,
} from "../../plugin/api.js";
import {
  asObject,
  isObject,
  num,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/kit/json.js";

export const HOST = "apis.fedex.com";
/** Tokens are renewed this long before FedEx says they expire. */
const MARGIN_MS = 60_000;

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

const storedSchema = z.object({
  /** Which credentials the token belongs to; a changed key starts over. */
  base: z.string(),
  accessToken: z.string().min(1),
  expiresAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session">;

const fingerprint = (credentials: Credentials): string =>
  createHash("sha256").update(credentials.clientId).digest("hex").slice(0, 16);

/**
 * One token request with the user's own API key. Only an explicit refusal is a sign-in
 * problem; network errors and server errors stay transient and never count as a refusal.
 */
async function requestToken(deps: Deps, credentials: Credentials): Promise<Stored> {
  const response = await deps.http.request(new URL(`https://${HOST}/oauth/token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("FedEx refused the API key.");
  }
  if (response.status !== 200) {
    throw new TransientError(`FedEx's token endpoint answered HTTP ${response.status}.`);
  }
  const body = asObject(readJson(response, "FedEx's token endpoint"));
  const accessToken = text(body["access_token"]);
  const expiresIn = num(body["expires_in"]);
  if (accessToken === null || expiresIn === null) {
    throw new UnexpectedResponseError("FedEx's token response has no token.");
  }
  const stored: Stored = {
    base: fingerprint(credentials),
    accessToken,
    expiresAt: deps.clock.now().getTime() + Math.max(0, expiresIn * 1000 - MARGIN_MS),
  };
  await deps.session.save(stored);
  return stored;
}

/** The access token of one source: reused while valid, renewed when expired or refused once. */
export class FedExSession {
  #stored: Stored | null;

  constructor(
    private readonly deps: Deps,
    private readonly credentials: Credentials,
  ) {
    const parsed = storedSchema.safeParse(deps.session.load());
    this.#stored =
      parsed.success && parsed.data.base === fingerprint(credentials) ? parsed.data : null;
  }

  async #token(): Promise<string> {
    if (this.#stored === null || this.deps.clock.now().getTime() >= this.#stored.expiresAt) {
      this.#stored = await requestToken(this.deps, this.credentials);
    }
    return this.#stored.accessToken;
  }

  async #post(code: string): Promise<HttpResponse> {
    return this.deps.http.request(new URL(`https://${HOST}/track/v1/trackingnumbers`), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${await this.#token()}`,
        "x-locale": "en_US",
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber: code } }],
      }),
    });
  }

  /** The track result for one number; null when FedEx does not know it. */
  async track(code: string): Promise<Json | null> {
    let response = await this.#post(code);
    if (response.status === 401) {
      // FedEx refused the token itself: renew it once, never on any other failure.
      this.#stored = null;
      response = await this.#post(code);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SignInRejectedError("FedEx refused a freshly issued token.");
    }
    if (response.status !== 200) {
      throw new TransientError(`FedEx tracking answered HTTP ${response.status}.`);
    }
    const output = asObject(asObject(readJson(response, "FedEx tracking"))["output"]);
    const complete = output["completeTrackResults"];
    if (!Array.isArray(complete)) {
      throw new UnexpectedResponseError("FedEx tracking has no results.");
    }
    const result = objects(asObject(complete[0])["trackResults"])[0];
    if (result === undefined) {
      return null;
    }
    // An unknown number comes back as a result that only carries an error.
    return isObject(result["error"]) && !isObject(result["latestStatusDetail"]) ? null : result;
  }
}
