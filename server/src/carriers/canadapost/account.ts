import { z } from "zod";
import type { Clock } from "../../clock.js";
import type { PluginHttp } from "../../plugin/http.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type PluginLogger,
  type SessionStore,
} from "../../plugin/api.js";
import { asArray, asObject, isObject, num, text, type Json } from "../_kit/json.js";

export const TOKEN_HOST = "sso-osu.canadapost-postescanada.ca";
export const LIST_HOST = "b3n4knmt6famlj575e5pfn74lm.appsync-api.ca-central-1.amazonaws.com";
const TOKEN_URL = `https://${TOKEN_HOST}/mga/sps/oauth/oauth20/token`;
const LIST_URL = `https://${LIST_HOST}/graphql`;
/** The public client the carrier's own app signs in with; there is no client secret. */
const CLIENT_ID = "cpc-nativeapp-2020";
const REFRESH_MARGIN_MS = 60_000;
/** Pages are 300 items; more than this many pages means pagination is not advancing. */
const MAX_PAGES = 20;

const LIST_QUERY =
  "query($n:String){listTrackSyncItems(limit:300,nextToken:$n){items{id trackId " +
  "userDescription type source deleted isFlaggedAsNotMine createdAt updatedAt}nextToken}}";

const SECOND_FACTOR =
  /(?<![a-z0-9])(verification|two[-_ ]?step|2sv|mfa|otp|security[-_ ]?question)(?![a-z0-9])/;

const tokensSchema = z.object({
  accessToken: z.string(),
  idToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number().nullable(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

function body(response: HttpResponse): unknown {
  try {
    return response.json();
  } catch {
    return null;
  }
}

export class CanadaPostAccount {
  #tokens: Tokens | null;

  constructor(
    private readonly http: PluginHttp,
    private readonly clock: Clock,
    private readonly session: SessionStore,
    private readonly logger: PluginLogger,
  ) {
    const stored = tokensSchema.safeParse(session.load());
    this.#tokens = stored.success ? stored.data : null;
  }

  async #tokenRequest(form: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const response = await this.http.request(new URL(TOKEN_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...form, client_id: CLIENT_ID, scope: "openid profile" }),
    });
    return { status: response.status, body: body(response) };
  }

  async #adopt(payload: Json): Promise<void> {
    const accessToken = text(payload["access_token"]);
    const idToken = text(payload["id_token"]);
    if (accessToken === null || idToken === null) {
      throw new UnexpectedResponseError("Canada Post sign-in returned no tokens.");
    }
    const expiresIn = num(payload["expires_in"]);
    this.#tokens = {
      accessToken,
      idToken,
      refreshToken: text(payload["refresh_token"]) ?? this.#tokens?.refreshToken ?? null,
      expiresAt: expiresIn === null ? null : this.clock.now().getTime() + expiresIn * 1000,
    };
    await this.session.save(this.#tokens);
  }

  /** Signs in with the password. A refusal asks the user; anything else is transient. */
  async signIn(credentials: Credentials): Promise<void> {
    const { status, body: payload } = await this.#tokenRequest({
      grant_type: "password",
      username: credentials.username,
      password: credentials.password,
    });
    if (status === 200 && isObject(payload) && text(payload["access_token"]) !== null) {
      await this.#adopt(payload);
      return;
    }
    if (SECOND_FACTOR.test(JSON.stringify(payload ?? "").toLowerCase())) {
      throw new SignInRejectedError(
        "Canada Post asked for a second factor, which is not supported.",
      );
    }
    if ([400, 401, 403].includes(status) && isObject(payload) && payload["error"] !== undefined) {
      throw new SignInRejectedError("Canada Post refused the username or password.");
    }
    throw new TransientError(`Canada Post sign-in answered HTTP ${status}.`);
  }

  /** Renews the tokens once. Returns false when the carrier refused the refresh token. */
  async #refresh(): Promise<boolean> {
    const refreshToken = this.#tokens?.refreshToken ?? null;
    if (refreshToken === null) {
      return false;
    }
    const { status, body: payload } = await this.#tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (status >= 500 || (status !== 200 && !isObject(payload))) {
      throw new TransientError(`Canada Post token refresh answered HTTP ${status}.`);
    }
    if (status !== 200 || !isObject(payload) || text(payload["id_token"]) === null) {
      this.logger.info({ status }, "Canada Post refused the refresh token.");
      return false;
    }
    await this.#adopt(payload);
    return true;
  }

  /** Makes sure there are fresh tokens: refresh first, then the password once. */
  async #renew(credentials: Credentials): Promise<void> {
    if (!(await this.#refresh())) {
      await this.signIn(credentials);
    }
  }

  async #page(next: string | null): Promise<{ status: number; body: unknown }> {
    const response = await this.http.request(new URL(LIST_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: this.#tokens?.idToken ?? "",
      },
      body: JSON.stringify({ query: LIST_QUERY, variables: { n: next } }),
    });
    return { status: response.status, body: body(response) };
  }

  static #unauthorized(status: number, payload: unknown): boolean {
    return (
      status === 401 ||
      asArray(asObject(payload)["errors"]).some((error) =>
        ["UnauthorizedException", "Unauthorized"].includes(
          text(asObject(error)["errorType"]) ?? "",
        ),
      )
    );
  }

  async #readPage(next: string | null, credentials: Credentials): Promise<Json> {
    let answer = await this.#page(next);
    if (CanadaPostAccount.#unauthorized(answer.status, answer.body)) {
      await this.#renew(credentials);
      answer = await this.#page(next);
      if (CanadaPostAccount.#unauthorized(answer.status, answer.body)) {
        throw new SignInRejectedError("Canada Post refused the renewed session.");
      }
    }
    const page = asObject(asObject(answer.body)["data"])["listTrackSyncItems"];
    if (answer.status !== 200 || !isObject(page)) {
      throw new UnexpectedResponseError(`Canada Post list answered HTTP ${answer.status}.`);
    }
    return page;
  }

  /** Every live, own tracked item on the account. */
  async listItems(credentials: Credentials): Promise<Json[]> {
    if (this.#tokens === null) {
      await this.signIn(credentials);
    } else if (
      this.#tokens.expiresAt !== null &&
      this.clock.now().getTime() >= this.#tokens.expiresAt - REFRESH_MARGIN_MS
    ) {
      await this.#renew(credentials);
    }
    const items: Json[] = [];
    let next: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.#readPage(next, credentials);
      for (const item of asArray(page["items"])) {
        if (
          isObject(item) &&
          text(item["trackId"]) !== null &&
          item["deleted"] !== true &&
          item["isFlaggedAsNotMine"] !== true
        ) {
          items.push(item);
        }
      }
      next = text(page["nextToken"]);
      if (next === null) {
        return items;
      }
    }
    throw new UnexpectedResponseError("Canada Post list pagination did not end.");
  }
}
