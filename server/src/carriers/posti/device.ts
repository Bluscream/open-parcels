import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isObject,
  parseJsonBody,
  text,
  type Clock,
  type HttpResponse,
  type Json,
  type PluginHttp,
} from "../../plugin/api.js";
import { DEVICE_MODEL, POSTI_APP } from "./keys.js";

/*
 * This service as a trusted device of an OmaPosti account. Right after the bank login it registers
 * an RSA key; afterwards a request signed with that key fetches the device's vault, and the key in
 * the vault renews the tokens. The device stays trusted until it is removed from the account.
 */

export const deviceSchema = z.object({
  deviceId: z.string().min(1),
  /** PKCS#8 PEM. Stored only inside the encrypted sign-in data. */
  privateKey: z.string().min(1),
  /** Base64; with no PIN, the salt alone gives the shared secret. */
  salt: z.string().min(1),
  /** The account the device belongs to (the ID token's `sub`). */
  subject: z.string().min(1),
});
export type Device = z.infer<typeof deviceSchema>;

export interface Tokens {
  readonly idToken: string;
  readonly roleTokens: Json[];
}

/** Device replies that mean Posti has dropped this device. */
const DROPPED = new Set(["INACTIVE_DEVICE", "NO_DEVICE_FOUND"]);
/** The refresh key in the vault always has this many characters. */
const VAULT_KEY_LENGTH = 44;

export const APP_HEADERS = { "user-agent": POSTI_APP.appUserAgent } as const;
const FORM_HEADERS = {
  ...APP_HEADERS,
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
};

const secretFromSalt = (salt: Buffer): string => createHash("sha256").update(salt).digest("hex");

function signText(privateKey: string, message: string): string {
  return sign("sha256", Buffer.from(message), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString("base64");
}

/** Posti rejects a signing time a device used before, so times never repeat per device. */
const lastSigned = new Map<string, number>();

function tick(clock: Clock, deviceId: string): number {
  const now = Math.max(
    Math.floor(clock.now().getTime() / 1000),
    (lastSigned.get(deviceId) ?? 0) + 1,
  );
  lastSigned.set(deviceId, now);
  return now;
}

/** The fields that prove a request comes from this device. */
export function proof(device: Device, clock: Clock): Json {
  const timestamp = tick(clock, device.deviceId);
  const secret = secretFromSalt(Buffer.from(device.salt, "base64"));
  return {
    device_id: device.deviceId,
    timestamp,
    device_sig: signText(device.privateKey, `device|${device.deviceId}|${String(timestamp)}`),
    user_sig: signText(
      device.privateKey,
      `user|${device.subject}|${device.deviceId}|${String(timestamp)}|${secret}|`,
    ),
  };
}

export function openVault(device: Device, vault: string): string {
  let opened: string;
  try {
    opened = privateDecrypt(
      { key: device.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(vault, "base64"),
    ).toString("ascii");
  } catch {
    throw new UnexpectedResponseError("Posti's device vault could not be opened.");
  }
  if (opened.length !== VAULT_KEY_LENGTH) {
    throw new UnexpectedResponseError("Posti's device vault held a key of an unexpected length.");
  }
  return opened;
}

/** The claims of a JWT, unverified: only used for the subject and the expiry. */
export function claims(token: string): Json {
  return asObject(parseJsonBody(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
}

function bodyOf(response: HttpResponse): Json {
  const body = parseJsonBody(response.body);
  if (!isObject(body)) {
    throw new TransientError(`Posti answered HTTP ${response.status} without JSON.`);
  }
  return body;
}

/** The error in a reply, whichever of Posti's shapes it uses. */
export function errorCode(body: Json): string | null {
  const error = body["error"];
  if (isObject(error)) {
    return text(error["message"]) ?? text(error["code"]);
  }
  return text(error) ?? text(body["message"]) ?? text(body["code"]);
}

async function postJson(http: PluginHttp, url: string, idToken: string, body: Json, extra = {}) {
  return http.request(new URL(url), {
    method: "POST",
    headers: {
      ...APP_HEADERS,
      ...extra,
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Renews the tokens with a trust token. The form is sent as is: the base64 keys contain
 * characters percent-encoding would change, and Posti compares them literally.
 */
async function renew(http: PluginHttp, form: string): Promise<Tokens> {
  const response = await http.request(new URL(`${POSTI_APP.authService}/device_refresh`), {
    method: "POST",
    headers: FORM_HEADERS,
    body: form,
  });
  const body = bodyOf(response);
  if (errorCode(body) === "invalid_grant") {
    throw new SignInRejectedError("Posti no longer accepts this device's renewal.");
  }
  const idToken = text(body["id_token"]);
  if (response.status !== 200 || idToken === null) {
    throw new TransientError(`Posti's token renewal answered HTTP ${response.status}.`);
  }
  return {
    idToken,
    roleTokens: Array.isArray(body["role_tokens"]) ? (body["role_tokens"] as Json[]) : [],
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Registers a device on the account that just logged in; returns it with renewed tokens. */
export async function provision(
  http: PluginHttp,
  clock: Clock,
  login: { idToken: string; refreshToken: string },
): Promise<{ device: Device; tokens: Tokens }> {
  const subject = text(claims(login.idToken)["sub"]);
  if (subject === null) {
    throw new UnexpectedResponseError("Posti's ID token names no account.");
  }
  const { verifier, challenge } = pkce();
  const initiate = new URL(`${POSTI_APP.mfa}/provisionings/initiate`);
  initiate.searchParams.set("locale", "fi");
  initiate.searchParams.set("state", randomUUID());
  initiate.searchParams.set("code_challenge", challenge);
  const begun = bodyOf(
    await postJson(
      http,
      initiate.toString(),
      login.idToken,
      {},
      { origin: "https://mfa.posti.fi/" },
    ),
  );
  const transaction = text(begun["transaction_id"]);
  const finalization = text(begun["finalization_code"]);
  if (transaction === null || finalization === null) {
    throw new TransientError("Posti did not start the device registration.");
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const salt = randomBytes(32);
  const shared = secretFromSalt(salt);
  const registered = await postJson(http, `${POSTI_APP.mfa}/provisionings`, login.idToken, {
    transaction_id: transaction,
    authorization_secret: shared,
    code_verifier: verifier,
    public_key: publicKey,
    device_fingerprint: randomBytes(8).toString("hex"),
    device_model: DEVICE_MODEL,
    enable_mfa: false,
    finalization_code: finalization,
    signature: signText(privateKey, shared + transaction),
  });
  const deviceId = text(bodyOf(registered)["device_id"]);
  if (![200, 201].includes(registered.status) || deviceId === null) {
    throw new TransientError(`Posti did not register the device (HTTP ${registered.status}).`);
  }
  const device: Device = { deviceId, privateKey, salt: salt.toString("base64"), subject };
  const trusted = await postJson(
    http,
    `${POSTI_APP.mfa}/device_trust_token`,
    login.idToken,
    proof(device, clock),
  );
  const trust = text(bodyOf(trusted)["token"]);
  if (![200, 201].includes(trusted.status) || trust === null) {
    throw new TransientError(`Posti did not trust the device (HTTP ${trusted.status}).`);
  }
  const tokens = await renew(
    http,
    `refresh_token=${login.refreshToken}&device_trust_token=${trust}&id_token=${login.idToken}`,
  );
  return { device, tokens };
}

/** Renews the tokens with the device alone. Only a dropped device or a refusal means "sign in". */
export async function refreshWithDevice(
  http: PluginHttp,
  clock: Clock,
  device: Device,
  idToken: string,
): Promise<Tokens> {
  const response = await postJson(
    http,
    `${POSTI_APP.mfa}/device_refresh`,
    idToken,
    proof(device, clock),
  );
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError(`Posti refused the device (HTTP ${response.status}).`);
  }
  const body = bodyOf(response);
  const problem = errorCode(body);
  if (problem !== null && DROPPED.has(problem)) {
    throw new SignInRejectedError("Posti no longer trusts this device.");
  }
  const trust = text(body["device_trust_token"]);
  const vault = text(body["vault_data"]);
  if (![200, 201].includes(response.status) || trust === null || vault === null) {
    // A moved endpoint must not send anyone back to their bank.
    throw new TransientError(`Posti's device service answered HTTP ${response.status}.`);
  }
  return renew(http, `refresh_token=${openVault(device, vault)}&device_trust_token=${trust}`);
}
