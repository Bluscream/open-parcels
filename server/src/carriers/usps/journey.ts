import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asArray,
  asObject,
  cleanText,
  isObject,
  objects,
  parseJsonBody,
  text,
  type InteractiveSignIn,
  type PluginHttp,
  type SignInContext,
  type SignInStep,
  type SignInTurn,
} from "../../plugin/api.js";
import type { InformedSecret } from "./informed.js";
import { INFORMED } from "./keys.js";

/*
 * Informed Delivery signs in through a ForgeRock journey: rounds of "callbacks" the client fills
 * and posts back until the journey hands out a token id. Only known callbacks are filled; the
 * ones that need the user become a sign-in step. Nothing outside that list is ever shown or sent.
 */

const AUTH_HEADERS = {
  "accept-api-version": "resource=2.0, protocol=1.0",
  "content-type": "application/json",
  accept: "application/json",
};
/** Rounds the journey may take on its own before it counts as stuck. */
const MAX_ROUNDS = 12;
/** Questions answered by the user before the journey counts as looping. */
const MAX_CHALLENGES = 5;
/** How long an approval on the phone may take; USPS asks to wait between checks. */
const APPROVAL_TIMEOUT_SECONDS = 180;
const REJECTION = /recogni[sz]e|incorrect|invalid|missing|try again/i;
const PASSWORD_CALLBACKS = new Set(["PasswordCallback", "ValidatedCreatePasswordCallback"]);
const NAME_CALLBACKS = new Set(["NameCallback", "ValidatedCreateUsernameCallback"]);
const CODE_CALLBACKS = new Set(["TextInputCallback", "OneTimePasswordCallback"]);
const CHOICE_CALLBACKS = new Set(["ChoiceCallback", "ConfirmationCallback"]);
const PASSIVE_CALLBACKS = new Set(["TextOutputCallback", "HiddenValueCallback"]);

interface JourneyState {
  readonly endpoint: string;
  readonly cookieName: string;
  readonly deviceId: string;
  readonly payload: Node;
  /** Index of the callback the current step asks about. */
  readonly pending: number;
  /** Callbacks of this round the user already answered. */
  readonly answered: readonly number[];
  readonly challenges: number;
}

/** Journey payloads are filled in place before they are posted back, so they stay mutable. */
type Node = Record<string, unknown>;

function nodes(value: unknown): Node[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(
        (item): item is Node => typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function output(callback: Node, name: string): unknown {
  return objects(callback["output"]).find((item) => item["name"] === name)?.["value"];
}

function setInput(callback: Node, value: unknown): void {
  const inputs = nodes(callback["input"]);
  const first = inputs[0] ?? {};
  first["value"] = value;
  callback["input"] = inputs.length === 0 ? [first] : inputs;
}

function callbacksOf(payload: Node): Node[] {
  return nodes(payload["callbacks"]);
}

/** Server text without markup or control characters. Script messages (type 4) are not text. */
function messages(callbacks: readonly Node[]): string[] {
  return callbacks
    .filter(
      (cb) => cb["type"] === "TextOutputCallback" && String(output(cb, "messageType")) !== "4",
    )
    .map((cb) => cleanText((text(output(cb, "message")) ?? "").replace(/<[^>]+>/g, " ")))
    .map((message) => message.replace(/\p{Cc}|\p{Cf}/gu, ""))
    .filter((message) => message !== "");
}

function choices(callback: Node): string[] {
  const list = objects(callback["output"]).find(
    (item) => item["name"] === "choices" || item["name"] === "options",
  )?.["value"];
  return asArray(list).map(String);
}

function deviceProfile(deviceId: string): string {
  return JSON.stringify({
    identifier: deviceId,
    metadata: {
      hardware: {},
      browser: { userAgent: "open-parcels" },
      platform: { deviceName: "open-parcels", platform: "open-parcels" },
    },
  });
}

/** Fills what may be filled automatically; returns the first callback that needs the user. */
function fill(
  payload: Node,
  answered: readonly number[],
  deviceId: string,
  credentials: { username: string; password: string } | null,
): number | null {
  const callbacks = callbacksOf(payload);
  const credentialsRound = callbacks.some((cb) => PASSWORD_CALLBACKS.has(String(cb["type"])));
  if (credentialsRound && credentials === null) {
    throw new SignInRejectedError("USPS asked for the username and password again.");
  }
  let challenge: number | null = null;
  callbacks.forEach((callback, index) => {
    const type = String(callback["type"]);
    const open = !answered.includes(index) && challenge === null;
    if (type === "SelectIdPCallback") {
      setInput(callback, "localAuthentication");
    } else if (credentialsRound && credentials !== null && NAME_CALLBACKS.has(type)) {
      setInput(callback, credentials.username);
    } else if (credentials !== null && PASSWORD_CALLBACKS.has(type)) {
      setInput(callback, credentials.password);
    } else if (type === "DeviceProfileCallback") {
      setInput(callback, deviceProfile(deviceId));
    } else if (type === "BooleanAttributeInputCallback") {
      // Optional attributes keep the server's default; only a required one is asked.
      challenge = output(callback, "required") === true && open ? index : challenge;
    } else if (NAME_CALLBACKS.has(type) || CODE_CALLBACKS.has(type) || CHOICE_CALLBACKS.has(type)) {
      challenge = open ? index : challenge;
    } else if (!PASSIVE_CALLBACKS.has(type) && type !== "PollingWaitCallback") {
      throw new UnexpectedResponseError(`USPS's sign-in asked something unknown (${type}).`);
    }
  });
  return challenge;
}

/** The step that asks the user about one callback. */
function stepFor(payload: Node, index: number): SignInStep {
  const callbacks = callbacksOf(payload);
  const callback = callbacks[index] ?? {};
  const own = cleanText(text(output(callback, "prompt")) ?? "");
  const message = [...messages(callbacks), own].filter((part) => part !== "").join(" ");
  const type = String(callback["type"]);
  if (CHOICE_CALLBACKS.has(type)) {
    return {
      kind: "choose_method",
      options: choices(callback).map((label, at) => ({ id: String(at), label })),
      message,
    };
  }
  if (type === "BooleanAttributeInputCallback") {
    return {
      kind: "choose_method",
      options: [
        { id: "true", label: "Yes" },
        { id: "false", label: "No" },
      ],
      message,
    };
  }
  return {
    kind: "otp_code",
    channel: /e-?mail/i.test(message) ? "email" : /text|sms|phone/i.test(message) ? "sms" : "other",
    destination: null,
    message,
  };
}

function answer(callback: Node, input: Readonly<Record<string, string>>): void {
  const type = String(callback["type"]);
  if (CHOICE_CALLBACKS.has(type)) {
    setInput(callback, Number(input["choice"]));
  } else if (type === "BooleanAttributeInputCallback") {
    setInput(callback, input["choice"] === "true");
  } else {
    setInput(callback, (input["code"] ?? "").trim());
  }
}

function waitSeconds(callbacks: readonly Node[]): number | null {
  for (const callback of callbacks) {
    const wait = Number(output(callback, "waitTime") ?? 0);
    if (callback["type"] === "PollingWaitCallback" && wait > 0) {
      return Math.max(1, Math.ceil(wait / 1000));
    }
  }
  return null;
}

async function postRound(http: PluginHttp, state: Pick<JourneyState, "endpoint">, payload: Node) {
  const response = await http.request(new URL(state.endpoint), {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify(payload),
  });
  if (response.status === 401) {
    throw new SignInRejectedError("USPS did not accept the sign-in.");
  }
  if (response.status !== 200) {
    throw new TransientError(`USPS's sign-in answered HTTP ${response.status}.`);
  }
  const body = parseJsonBody(response.body);
  if (!isObject(body)) {
    throw new TransientError("USPS's sign-in did not answer with JSON.");
  }
  return body;
}

/**
 * Posts the journey until it needs the user or finishes. A step is returned with the state to
 * continue from; a finished journey yields its token id.
 */
async function advance(
  http: PluginHttp,
  state: JourneyState,
  credentials: { username: string; password: string } | null,
): Promise<{ step: SignInStep; state: JourneyState } | { tokenId: string }> {
  let payload = state.payload;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const journey = await postRound(http, state, payload);
    const tokenId = text(journey["tokenId"]);
    if (tokenId !== null) {
      return { tokenId };
    }
    const callbacks = callbacksOf(journey);
    const wait = waitSeconds(callbacks);
    const next = { ...state, payload: journey, answered: [], pending: -1 };
    if (wait !== null) {
      const step: SignInStep = {
        kind: "await_approval",
        message: messages(callbacks).join(" ") || "Approve the sign-in on your phone.",
        pollIntervalSeconds: wait,
        timeoutSeconds: APPROVAL_TIMEOUT_SECONDS,
      };
      return { step, state: next };
    }
    if (callbacks.some((cb) => cb["type"] === "ConfirmationCallback")) {
      if (messages(callbacks).some((message) => REJECTION.test(message))) {
        throw new SignInRejectedError("USPS did not accept that. Check it and try again.");
      }
    }
    const pending = fill(journey, [], state.deviceId, round === 0 ? credentials : null);
    if (pending !== null) {
      return { step: stepFor(journey, pending), state: { ...next, pending } };
    }
    payload = journey;
  }
  throw new TransientError("USPS's sign-in did not finish.");
}

/** Trades the journey's token id for the token chain and the enrolled addresses. */
async function finish(
  http: PluginHttp,
  state: Pick<JourneyState, "cookieName">,
  tokenId: string,
): Promise<InformedSecret> {
  const verifier = randomBytes(48).toString("base64url");
  const authorize = new URL(`${INFORMED.am}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    client_id: INFORMED.clientId,
    redirect_uri: INFORMED.redirectUri,
    scope: "openid profile informed-delivery",
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    regApp: "ID",
  })) {
    authorize.searchParams.set(key, value);
  }
  const redirect = await http.request(authorize, {
    headers: { cookie: `${state.cookieName}=${tokenId}` },
    redirect: "manual",
  });
  const location = redirect.headers.get("location");
  const code = location === null ? null : new URL(location, authorize).searchParams.get("code");
  if (code === null) {
    throw new SignInRejectedError("USPS did not hand out an authorisation code.");
  }
  const tokens = await http.request(new URL(`${INFORMED.am}/oauth2/access_token`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: INFORMED.clientId,
      code,
      redirect_uri: INFORMED.redirectUri,
      code_verifier: verifier,
    }),
  });
  const body = asObject(parseJsonBody(tokens.body));
  const access = text(body["access_token"]);
  const refresh = text(body["refresh_token"]);
  if (tokens.status !== 200 || access === null || refresh === null) {
    throw new TransientError(`USPS's token exchange answered HTTP ${tokens.status}.`);
  }
  const profile = await http.request(new URL(`${INFORMED.am}/oauth2/userinfo`), {
    headers: { authorization: `Bearer ${access}`, accept: "application/json" },
  });
  if (profile.status !== 200) {
    throw new TransientError(`USPS's profile answered HTTP ${profile.status}.`);
  }
  const addresses = enrolledAddresses(parseJsonBody(profile.body));
  if (addresses.length === 0) {
    throw new SignInRejectedError(
      "This USPS account has no address enrolled in Informed Delivery.",
    );
  }
  return { informed: { refreshToken: refresh, addresses } };
}

/** The 11-digit ZIP of each address enrolled in Informed Delivery. */
export function enrolledAddresses(profile: unknown): string[] {
  const result: string[] = [];
  for (const address of objects(asObject(profile)["addresses"])) {
    if (!asArray(address["granted_services"]).includes("RMIN")) {
      continue;
    }
    // Each part keeps its own width: an unpadded delivery point names another household.
    const parts = (
      [
        ["ZIPCode", 5],
        ["ZIPPlus4", 4],
        ["deliveryPoint", 2],
      ] as const
    ).map(([key, width]) => {
      const value = text(address[key])?.trim() ?? "";
      return value === "" ? null : value.padStart(width, "0");
    });
    const zip11 = parts.every((part) => part !== null) ? parts.join("") : "";
    if (/^\d{11}$/.test(zip11)) {
      result.push(zip11);
    }
  }
  return result;
}

const journeyStateSchema = z.object({
  endpoint: z.string(),
  cookieName: z.string(),
  deviceId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  pending: z.number(),
  answered: z.array(z.number()),
  challenges: z.number(),
});

function journeyState(raw: unknown): JourneyState {
  const parsed = journeyStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UnexpectedResponseError("The stored USPS sign-in is incomplete.");
  }
  return parsed.data;
}

async function settle<Config>(
  context: SignInContext<Config>,
  state: JourneyState,
  credentials: { username: string; password: string } | null,
): Promise<SignInTurn<InformedSecret>> {
  const result = await advance(context.http, state, credentials);
  if ("tokenId" in result) {
    return { secret: await finish(context.http, state, result.tokenId) };
  }
  return result;
}

/** The USPS Informed Delivery sign-in: password, then whatever verification USPS asks for. */
export function informedSignIn<Config>(): InteractiveSignIn<Config, InformedSecret> {
  return {
    type: "interactive",
    id: "informed_delivery",
    label: "USPS Informed Delivery (username, password and verification)",
    kinds: ["account"],
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [
            { name: "username", label: "USPS username", type: "text" },
            { name: "password", label: "Password", type: "password" },
          ],
        },
        state: null,
      }),
    async continue(context, rawState, input) {
      if (rawState === null) {
        const username = (input["username"] ?? "").trim();
        const server = await context.http.request(new URL(`${INFORMED.am}/json/serverinfo/*`), {
          headers: { accept: "application/json" },
        });
        if (server.status !== 200) {
          throw new TransientError(`USPS's sign-in answered HTTP ${server.status}.`);
        }
        const info = asObject(parseJsonBody(server.body));
        const realm = (text(info["realm"]) ?? "/alpha").replace(/^\/+|\/+$/g, "");
        const state: JourneyState = {
          endpoint: `${INFORMED.am}/json/realms/root/realms/${realm}/authenticate`,
          cookieName: text(info["cookieName"]) ?? "iPlanetDirectoryPro",
          // Stable per account: a new device on every sign-in invites extra verification.
          deviceId: createHash("sha256")
            .update(`open-parcels:usps:${username}`)
            .digest("hex")
            .slice(0, 32),
          payload: {},
          pending: -1,
          answered: [],
          challenges: 0,
        };
        return settle(context, state, { username, password: input["password"] ?? "" });
      }
      const state = journeyState(rawState);
      if (state.challenges >= MAX_CHALLENGES) {
        throw new SignInRejectedError("USPS keeps asking; start the sign-in again.");
      }
      const payload = structuredClone(state.payload);
      const callback = callbacksOf(payload)[state.pending];
      if (callback === undefined) {
        throw new UnexpectedResponseError("The stored USPS question is gone.");
      }
      answer(callback, input);
      const answered = [...state.answered, state.pending];
      // Another question in the same round is asked before anything is sent.
      const next = fill(payload, answered, state.deviceId, null);
      const moved = { ...state, payload, answered, challenges: state.challenges + 1 };
      if (next !== null) {
        return { step: stepFor(payload, next), state: { ...moved, pending: next } };
      }
      return settle(context, moved, null);
    },
    async poll(context, rawState) {
      // A waiting round is posted back unchanged; the answer is the next round.
      return settle(context, journeyState(rawState), null);
    },
  };
}
