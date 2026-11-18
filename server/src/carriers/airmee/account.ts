import { createHash } from "node:crypto";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isObject,
  objects,
  readJson,
  text,
  type FetchResult,
  type HttpResponse,
  type InteractiveSignIn,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";

const CUSTOMER = "https://api.airmee.com/customer";
/** What the app sends before it has a token, and with the refresh call. */
const TEMP_TOKEN = "TEMP_TOKEN";

export interface AirmeeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "session" | "reportUnknown">;

/** The tokens never go to a log: the header carries the raw token, without "Bearer". */
async function post(http: PluginHttp, path: string, body: Json, token: string) {
  return http.request(new URL(`${CUSTOMER}/${path}`), {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function field(payload: unknown, key: string): string {
  const value = isObject(payload) ? text(payload[key], { numbers: false }) : null;
  if (value === null) {
    throw new UnexpectedResponseError(`Airmee answered without ${key}.`);
  }
  return value;
}

/** A pre-login call: a 4xx is a refusal of what the user typed, a 5xx is Airmee being down. */
function checked(response: HttpResponse, what: string): unknown {
  if (response.status >= 400 && response.status < 500) {
    throw new SignInRejectedError(`Airmee refused the ${what} (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`Airmee's ${what} answered HTTP ${response.status}.`);
  }
  return readJson(response, "Airmee");
}

function tokensOf(payload: unknown): AirmeeTokens {
  return {
    accessToken: field(payload, "access_token"),
    refreshToken: field(payload, "refresh_token"),
  };
}

/** Phone sign-in: Airmee texts a code to the number, the user types it in. */
export function smsSignIn<Config>(): InteractiveSignIn<Config, AirmeeTokens> {
  return {
    type: "interactive",
    id: "sms_code",
    label: "Airmee account (code by text message)",
    kinds: ["account"],
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [
            { name: "country_code", label: "Country code (e.g. +46)", type: "tel" },
            { name: "phone_number", label: "Phone number", type: "tel" },
          ],
          message: "The phone number Airmee delivers to. Airmee texts a code to it.",
        },
        state: null,
      }),
    async continue(context, rawState, input) {
      if (rawState === null) {
        const phone = {
          country_code: (input["country_code"] ?? "").trim(),
          phone_number: (input["phone_number"] ?? "").trim(),
        };
        const sent = checked(
          await post(context.http, "register/sendOtp", phone, TEMP_TOKEN),
          "phone number",
        );
        return {
          step: {
            kind: "otp_code",
            channel: "sms",
            destination: `…${phone.phone_number.slice(-2)}`,
          },
          state: {
            ...phone,
            tempToken: field(sent, "temp_token"),
            hash: field(sent, "otp_hash_code"),
          },
        };
      }
      const state = asObject(rawState);
      const verified = checked(
        await post(
          context.http,
          "register/verifyOtp",
          {
            country_code: state["country_code"] ?? "",
            phone_number: state["phone_number"] ?? "",
            otp_code: (input["code"] ?? "").trim(),
            otp_hash_code: state["hash"] ?? "",
          },
          text(state["tempToken"]) ?? "",
        ),
        "code",
      );
      return { secret: tokensOf(verified) };
    },
  };
}

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The rotating token pair of one account, newest first in the session store. */
class Session {
  #tokens: AirmeeTokens;
  readonly #base: string;

  constructor(
    private readonly deps: Deps,
    signedIn: AirmeeTokens,
  ) {
    this.#base = fingerprint(signedIn.refreshToken);
    const saved = asObject(deps.session.load());
    const access = text(saved["accessToken"]);
    const refresh = text(saved["refreshToken"]);
    this.#tokens =
      saved["base"] === this.#base && access !== null && refresh !== null
        ? { accessToken: access, refreshToken: refresh }
        : signedIn;
  }

  get access(): string {
    return this.#tokens.accessToken;
  }

  /** Rotates both tokens, once per refused access token. Only 400/401/403 mean "sign in again". */
  async refresh(): Promise<void> {
    const response = await post(
      this.deps.http,
      "register/refreshToken",
      { refresh_token: this.#tokens.refreshToken },
      TEMP_TOKEN,
    );
    if ([400, 401, 403].includes(response.status)) {
      throw new SignInRejectedError("Airmee no longer accepts the sign-in.");
    }
    if (response.status !== 200) {
      throw new TransientError(`Airmee's token refresh answered HTTP ${response.status}.`);
    }
    this.#tokens = tokensOf(readJson(response, "Airmee"));
    await this.deps.session.save({ base: this.#base, ...this.#tokens });
  }
}

async function list(deps: Deps, session: Session, path: string): Promise<Json[]> {
  for (const retry of [false, true]) {
    const response = await deps.http.request(new URL(`${CUSTOMER}/${path}`), {
      headers: { authorization: session.access, accept: "application/json" },
    });
    if (response.status === 401 && !retry) {
      await session.refresh();
      continue;
    }
    if (response.status === 401) {
      throw new SignInRejectedError("Airmee refused a freshly renewed token.");
    }
    if (response.status !== 200) {
      throw new TransientError(`Airmee's ${path} answered HTTP ${response.status}.`);
    }
    const payload = readJson(response, "Airmee");
    if (!Array.isArray(payload)) {
      throw new UnexpectedResponseError(`Airmee's ${path} is not a list.`);
    }
    return objects(payload);
  }
  return [];
}

/** Active and completed deliveries as one list, each order once, keyed by its own id. */
export async function fetchAirmeeAccount(
  deps: Deps,
  signedIn: AirmeeTokens,
  toSnapshot: (raw: Json, reference: string) => ParcelSnapshot,
): Promise<FetchResult> {
  const session = new Session(deps, signedIn);
  const seen = new Set<string>();
  const snapshots: ParcelSnapshot[] = [];
  for (const path of ["deliveries", "deliveries/completed"]) {
    for (const order of await list(deps, session, path)) {
      const reference = text(order["id"]) ?? text(order["receipt_id"]);
      if (reference === null || seen.has(reference)) {
        continue;
      }
      seen.add(reference);
      snapshots.push(toSnapshot(order, reference));
    }
  }
  return { snapshots, complete: true };
}
