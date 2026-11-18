import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asObject,
  carrierKey,
  num,
  parseJsonBody,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  text,
  type HttpResponse,
  type InteractiveSignIn,
  type PluginContext,
  type PluginHttp,
  type SignInContext,
} from "../../plugin/api.js";
import { API_HOST, CARRIER_ID } from "./shared.js";

export const B2C_HOST = "pplczmobidentity.b2clogin.com";
const TOKEN_URL = `https://${B2C_HOST}/PPLCZMobIdentity.onmicrosoft.com/B2C_1A_ROPC_AUTH/oauth2/v2.0/token`;
const MOBAPP = `https://${API_HOST}/ecs/ppl/mobapp`;
const MARGIN_MS = 120_000;

export interface Secret {
  readonly email: string;
  readonly password: string;
}

const appKey = (): string => carrierKey(CARRIER_ID, "app_key");
const clientId = (): string => carrierKey(CARRIER_ID, "client_id");

/**
 * The app's password grant. The password is the one PPL minted for this sign-in; the app never
 * refreshes, it runs this grant again. Only `access_denied`/`invalid_grant` (or a 401/403) mean
 * the stored password is dead, which happens when the user signs in to the app again.
 */
async function passwordGrant(http: PluginHttp, secret: Secret) {
  const response = await http.request(new URL(TOKEN_URL), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({
      client_id: clientId(),
      scope: `openid ${clientId()} offline_access`,
      grant_type: "password",
      username: secret.email,
      password: secret.password,
    }),
  });
  const body = asObject(parseJsonBody(response.body));
  const error = text(body["error"]);
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && (error === "access_denied" || error === "invalid_grant"))
  ) {
    throw new SignInRejectedError(
      "PPL refused the stored sign-in; signing in to the mojePPL app replaces it.",
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`PPL's token endpoint answered HTTP ${response.status}.`);
  }
  const access = text(body["access_token"]);
  if (access === null) {
    // B2C answers some of its own outages with an HTML page and HTTP 200.
    throw new UnexpectedResponseError("PPL's token endpoint answered without a token.");
  }
  return { access, lifetimeMs: (num(body["expires_in"]) ?? 3600) * 1000 };
}

const flowState = z.object({
  email: z.string().optional(),
  deviceId: z.string(),
  registration: z.string().optional(),
});

/**
 * The app's passwordless sign-in: an e-mail address, a PIN sent to it, and the PIN traded for a
 * password PPL mints for this device. The password is then proven with one token request.
 */
export function pinSignIn<Config>(): InteractiveSignIn<Config, Secret> {
  return {
    type: "interactive",
    id: "email_pin",
    label: "Sign in with an e-mailed PIN",
    kinds: ["account"],
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [{ name: "email", label: "E-mail address", type: "email" }],
          message: "PPL e-mails a PIN to this address. Signing in here signs the app out.",
        },
        state: { deviceId: randomUUID() },
      }),
    async continue(context: SignInContext<Config>, raw, input) {
      const state = flowState.parse(raw);
      if (state.registration === undefined) {
        const email = (input["email"] ?? "").trim();
        const registration = randomUUID();
        const response = await context.http.request(new URL(`${MOBAPP}/api/v1/registrations`), {
          method: "POST",
          headers: { "dhl-api-key": appKey(), "content-type": "application/json" },
          body: JSON.stringify({
            email,
            deviceId: state.deviceId,
            registrationSessionId: registration,
          }),
        });
        if (response.status !== 204) {
          throw new TransientError(`PPL's PIN request answered HTTP ${response.status}.`);
        }
        return {
          step: { kind: "otp_code", channel: "email", destination: null },
          state: { ...state, email, registration },
        };
      }
      const response = await context.http.request(
        new URL(`${MOBAPP}/api/v1/registrations/${encodeURIComponent(state.registration)}`),
        {
          method: "PUT",
          headers: { "dhl-api-key": appKey(), "content-type": "application/json" },
          body: JSON.stringify({ pin: (input["code"] ?? "").trim(), deviceId: state.deviceId }),
        },
      );
      if ([400, 401, 404, 422].includes(response.status)) {
        throw new SignInRejectedError("PPL did not accept the PIN.");
      }
      if (response.status !== 200) {
        throw new TransientError(`PPL's PIN check answered HTTP ${response.status}.`);
      }
      const minted = text(asObject(parseJsonBody(response.body))["password"]);
      if (minted === null || state.email === undefined) {
        throw new UnexpectedResponseError("PPL's PIN check gave no password.");
      }
      const secret: Secret = { email: state.email, password: minted };
      await passwordGrant(context.http, secret);
      return { secret };
    },
  };
}

const storedSchema = z.object({ access: z.string(), expiresAt: z.number() });

/** The signed-in gateway. A refused bearer is renewed once by running the grant again. */
export class PplAccount {
  #access: string | null;
  #expiresAt: number;
  #changed = false;

  constructor(private readonly context: PluginContext<unknown, Secret>) {
    const stored = storedSchema.safeParse(context.session.load());
    this.#access = stored.success ? stored.data.access : null;
    this.#expiresAt = stored.success ? stored.data.expiresAt : 0;
  }

  async #renew(): Promise<string> {
    const tokens = await passwordGrant(this.context.http, this.context.secret);
    this.#access = tokens.access;
    this.#expiresAt = this.context.clock.now().getTime() + tokens.lifetimeMs;
    this.#changed = true;
    return tokens.access;
  }

  async save(): Promise<void> {
    if (this.#changed && this.#access !== null) {
      await this.context.session.save({ access: this.#access, expiresAt: this.#expiresAt });
    }
  }

  async get(path: string): Promise<HttpResponse> {
    const now = this.context.clock.now().getTime();
    const send = async (token: string) =>
      this.context.http.request(new URL(`${MOBAPP}${path}`), {
        headers: {
          "dhl-api-key": appKey(),
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });
    let response = await send(
      this.#access !== null && now < this.#expiresAt - MARGIN_MS
        ? this.#access
        : await this.#renew(),
    );
    if (response.status === 401) {
      response = await send(await this.#renew());
      if (response.status === 401) {
        throw new SignInRejectedError("PPL refused a freshly renewed session.");
      }
    }
    if (response.status !== 200) {
      throw new TransientError(`PPL ${path} answered HTTP ${response.status}.`);
    }
    return response;
  }
}
