import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CookieJar } from "../../plugin/api.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import type { Storefront } from "./storefronts.js";

/**
 * Device registration: the user signs in on Amazon's own page in their browser, as a new device of
 * their account, and pastes the address the browser lands on. That address carries a one-time
 * authorisation code, which is exchanged (with the PKCE verifier only we know) for a refresh
 * token. The password never reaches us; the device shows up in the user's Amazon device list and
 * can be removed there.
 */

const APP_NAME = "Alexa Media Player";
const APP_VERSION = "2.2.556530.0";
/** Shown in the user's device list. */
const DEVICE_NAME = "open-parcels";
const DEVICE_TYPE = "A2IVLV5VM2W81";
const DEVICE_ID_SUFFIX = "23413249564c5635564d32573831";
const LANDING_URL = "https://www.amazon.com/ap/maplanding";
const GLOBAL_API_HOST = "api.amazon.com";
const CODE_PARAM = "openid.oa2.authorization_code";

const TOKEN_FIELDS = {
  app_name: APP_NAME,
  app_version: APP_VERSION,
  "di.sdk.version": "6.12.4",
  package_name: "com.amazon.echo",
  "di.hw.version": "iPhone",
  platform: "iOS",
  "di.os.name": "iOS",
  "di.os.version": "16.6",
  current_version: "6.12.4",
  previous_version: "6.12.4",
} as const;

export const signInStateSchema = z.object({
  deviceSerial: z.string().regex(/^[0-9A-F]{32}$/),
  verifier: z.string().min(43),
  storefront: z.string(),
});
export type SignInState = z.infer<typeof signInStateSchema>;

export const amazonSecretSchema = z.object({
  refreshToken: z.string().min(1),
  deviceSerial: z.string().regex(/^[0-9A-F]{32}$/),
});
export type AmazonSecret = z.infer<typeof amazonSecretSchema>;

export function newDeviceSerial(): string {
  return randomUUID().replaceAll("-", "").toUpperCase();
}

export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function deviceId(serial: string): string {
  return Buffer.from(serial, "utf8").toString("hex") + DEVICE_ID_SUFFIX;
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The sign-in address the user opens in their own browser. */
export function signInUrl(storefront: Storefront, serial: string, verifier: string): string {
  const query = new URLSearchParams({
    "openid.return_to": LANDING_URL,
    "openid.assoc_handle": "amzn_dp_project_dee_ios",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    pageId: "amzn_dp_project_dee_ios",
    accountStatusPolicy: "P1",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.mode": "checkid_setup",
    "openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
    "openid.oa2.client_id": `device:${deviceId(serial)}`,
    "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
    "openid.oa2.response_type": "code",
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.pape.max_auth_age": "0",
    "openid.oa2.scope": "device_auth_access offline_access",
    "openid.oa2.code_challenge_method": "S256",
    "openid.oa2.code_challenge": codeChallenge(verifier),
    language: storefront.signInLanguage,
  });
  return `https://www.amazon.com/ap/signin?${query.toString()}`;
}

/** The authorisation code in the pasted landing address, or null when it is not there. */
export function authorizationCode(pasted: string): string | null {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*amazon\.[a-z.]+$/.test(host)) {
    return null;
  }
  const code = url.searchParams.get(CODE_PARAM);
  return code === null || code.trim() === "" ? null : code;
}

/** A 4xx other than 408/429 means "this sign-in is no good"; anything else is an outage. */
function isRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function jsonObject(response: HttpResponse, what: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = response.json();
  } catch {
    throw new UnexpectedResponseError(`Amazon's ${what} answer was not JSON.`);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new UnexpectedResponseError(`Amazon's ${what} answer was not a JSON object.`);
  }
  return body as Record<string, unknown>;
}

const registrationSchema = z.object({
  response: z.object({
    success: z.object({
      tokens: z.object({ bearer: z.object({ refresh_token: z.string().min(1) }) }),
    }),
  }),
});

/**
 * Exchanges the authorisation code for a refresh token. The regional API host is asked first,
 * then the global one; a rejection counts only when every host that answered rejected it, so one
 * host's outage never looks like a refused sign-in.
 */
export async function registerDevice(
  http: PluginHttp,
  storefront: Storefront,
  state: SignInState,
  code: string,
): Promise<AmazonSecret> {
  const payload = {
    requested_extensions: ["device_info", "customer_info"],
    cookies: { website_cookies: [], domain: `.${storefront.domain}` },
    registration_data: {
      domain: "Device",
      app_version: APP_VERSION,
      device_type: DEVICE_TYPE,
      device_name: `%FIRST_NAME%'s%DUPE_STRATEGY_1ST%${DEVICE_NAME}`,
      os_version: "16.6",
      device_serial: state.deviceSerial,
      device_model: "iPhone",
      app_name: APP_NAME,
      software_version: "1",
    },
    auth_data: {
      client_id: deviceId(state.deviceSerial),
      authorization_code: code,
      code_verifier: state.verifier,
      code_algorithm: "SHA-256",
      client_domain: "DeviceLegacy",
    },
    user_context_map: { frc: randomBytes(313).toString("base64").replace(/=+$/, "") },
    requested_token_type: ["bearer", "mac_dms", "website_cookies"],
  };
  const hosts = [...new Set([`api.${storefront.domain}`, GLOBAL_API_HOST])];
  const statuses: number[] = [];
  for (const host of hosts) {
    let response: HttpResponse;
    try {
      response = await http.request(new URL(`https://${host}/auth/register`), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof TransientError) {
        continue;
      }
      throw error;
    }
    if (response.status === 200) {
      const parsed = registrationSchema.safeParse(jsonObject(response, "device registration"));
      if (!parsed.success) {
        throw new SignInRejectedError("Amazon's device registration returned no refresh token.");
      }
      return {
        refreshToken: parsed.data.response.success.tokens.bearer.refresh_token,
        deviceSerial: state.deviceSerial,
      };
    }
    statuses.push(response.status);
  }
  if (statuses.length > 0 && statuses.every(isRejection)) {
    throw new SignInRejectedError(
      `Amazon refused the device registration (HTTP ${statuses.join(", ")}).`,
    );
  }
  throw new TransientError("Amazon's device registration could not be reached.");
}

const cookieSchema = z.object({
  Name: z.string().min(1),
  Value: z.string(),
  Path: z.string().optional(),
});
const cookieExchangeSchema = z.object({
  response: z.object({
    tokens: z.object({ cookies: z.record(z.string(), z.array(cookieSchema)) }),
  }),
});

/**
 * Mints website cookies for the storefront from the refresh token and puts them into `jar`.
 * A refused token is a `SignInRejectedError`; anything else that goes wrong is transient.
 */
export async function mintCookies(
  http: PluginHttp,
  storefront: Storefront,
  refreshToken: string,
  jar: CookieJar,
): Promise<void> {
  const form = new URLSearchParams({
    ...TOKEN_FIELDS,
    domain: `.${storefront.domain}`,
    source_token: refreshToken,
    requested_token_type: "auth_cookies",
    source_token_type: "refresh_token",
  });
  const origin = `https://www.${storefront.domain}/`;
  const response = await http.request(new URL(`${origin}ap/exchangetoken/cookies`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    redirect: "manual",
  });
  if (isRejection(response.status)) {
    throw new SignInRejectedError(
      `Amazon refused the stored sign-in (HTTP ${String(response.status)}).`,
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`Amazon's cookie exchange failed (HTTP ${String(response.status)}).`);
  }
  const parsed = cookieExchangeSchema.safeParse(jsonObject(response, "cookie exchange"));
  const groups = parsed.success ? Object.entries(parsed.data.response.tokens.cookies) : [];
  let stored = 0;
  for (const [domain, cookies] of groups) {
    for (const cookie of cookies) {
      const value = cookie.Value.replace(/^"|"$/g, "");
      const path = cookie.Path ?? "/";
      await jar.setCookie(
        `${cookie.Name}=${value}; Domain=${domain}; Path=${path}; Secure`,
        origin,
        {
          ignoreError: true,
        },
      );
      stored += 1;
    }
  }
  if (stored === 0) {
    throw new UnexpectedResponseError("Amazon's cookie exchange returned no cookies.");
  }
}
