import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  CookieJar,
  isObject,
  isoTime,
  restoreJar,
  serializeJar,
  SignInRejectedError,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type FetchResult,
  type InteractiveSignIn,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SignInScope,
} from "../../../plugin/api.js";
import { captcha, PL_HOST, plCall, plStatus } from "./public.js";

/** How this service shows in the account's device list; DHL binds the session to it. */
const DEVICE_NAME = "open-parcels";

export interface PlSignedIn {
  readonly deviceId: string;
  readonly jar: unknown;
}

const flowState = z.object({
  deviceId: z.string(),
  phone: z.string().optional(),
  jar: z.unknown(),
});

/** DHL keeps its JWT as two cookies; replacing both slides the session window. */
async function adoptToken(jar: CookieJar, token: string): Promise<void> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnexpectedResponseError("Mój DHL answered a token that is not a JWT.");
  }
  const origin = `https://${PL_HOST}/`;
  await jar.setCookie(
    `access-token=${parts.slice(0, 2).join(".")}; Domain=${PL_HOST}; Path=/; Secure`,
    origin,
  );
  await jar.setCookie(
    `access-signature=${parts[2] ?? ""}; Domain=${PL_HOST}; Path=/; Secure`,
    origin,
  );
}

/**
 * The website's SMS sign-in: a Polish phone number, a code by SMS, and "remember me", which
 * gives the long-lived cookie later runs restore the session with. Every step carries a freshly
 * solved Altcha challenge.
 */
export function plSignIn<Config>(
  scope: SignInScope<Config>,
): InteractiveSignIn<Config, { pl: PlSignedIn }> {
  return {
    type: "interactive",
    id: "pl_account",
    label: "Mój DHL account (Poland, SMS code)",
    kinds: ["account"],
    ...scope,
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [{ name: "phone", label: "Phone number (Poland, 9 digits)", type: "tel" }],
        },
        state: { deviceId: randomUUID(), jar: serializeJar(new CookieJar()) },
      }),
    async continue(context, raw, input) {
      const state = flowState.parse(raw);
      const jar = restoreJar(state.jar);
      if (state.phone === undefined) {
        const phone = (input["phone"] ?? "").replace(/\D/g, "").slice(-9);
        let last: unknown = null;
        for (const [path, body] of [
          ["/auth/validate-account", { phoneNumber: phone, prefix: "48" }],
          ["/auth/generate-code", { phoneNumber: phone, prefix: "48", isMobileDevice: false }],
        ] as const) {
          const answer = await plCall(context.http, path, {
            method: "POST",
            jar,
            body: { ...body, "captcha-payload": await captcha(context.http, jar) },
          });
          if (answer.status !== 200 || !isObject(answer.body)) {
            throw new TransientError(`Mój DHL ${path} answered HTTP ${answer.status}.`);
          }
          last = answer.body;
        }
        if (asObject(last)["responseCode"] !== 0) {
          throw new SignInRejectedError("Mój DHL declined to send an SMS to this number.");
        }
        return {
          step: { kind: "otp_code", channel: "sms", destination: null },
          state: { ...state, phone, jar: serializeJar(jar) },
        };
      }
      const answer = await plCall(context.http, "/auth/validate-code", {
        method: "POST",
        jar,
        body: {
          phoneNumber: state.phone,
          prefix: "48",
          smsCode: (input["code"] ?? "").trim(),
          deviceId: state.deviceId,
          deviceName: DEVICE_NAME,
          rememberMe: true,
          "captcha-payload": await captcha(context.http, jar),
        },
      });
      const token = text(asObject(asObject(answer.body)["token"])["token"]);
      if (answer.status !== 200 || asObject(answer.body)["success"] !== true || token === null) {
        throw new SignInRejectedError("Mój DHL did not accept the SMS code.");
      }
      await adoptToken(jar, token);
      return { secret: { pl: { deviceId: state.deviceId, jar: serializeJar(jar) } } };
    },
  };
}

const storedSchema = z.object({ base: z.string(), jar: z.unknown() });
const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * A bearer for this run. The short-lived access cookies are refreshed; once they have expired,
 * the remember-me cookie recovers the session (no challenge needed). Only an outright refusal of
 * that recovery sends the user back through the SMS sign-in.
 */
async function bearer(
  context: PluginContext<unknown, unknown>,
  signedIn: PlSignedIn,
  jar: CookieJar,
) {
  const device = { deviceId: signedIn.deviceId, deviceName: DEVICE_NAME };
  const refreshed = await plCall(context.http, "/auth/refresh", { jar, query: device });
  let token = text(asObject(refreshed.body)["token"]);
  if (refreshed.status === 401 || refreshed.status === 403) {
    const recovered = await plCall(context.http, "/auth/recover", {
      method: "POST",
      jar,
      body: device,
    });
    if ([400, 401, 403].includes(recovered.status)) {
      throw new SignInRejectedError("The Mój DHL session expired; sign in with an SMS code again.");
    }
    if (recovered.status !== 200) {
      throw new TransientError(`Mój DHL recover answered HTTP ${recovered.status}.`);
    }
    token = text(asObject(recovered.body)["token"]);
  } else if (refreshed.status !== 200) {
    throw new TransientError(`Mój DHL refresh answered HTTP ${refreshed.status}.`);
  }
  if (token === null) {
    throw new UnexpectedResponseError("Mój DHL gave no token.");
  }
  await adoptToken(jar, token);
  return token;
}

function accountSnapshot(raw: Json, report: (key: string) => void): ParcelSnapshot | null {
  const number = text(raw["shipmentNumber"]);
  if (number === null) {
    return null;
  }
  const timeline = asObject(raw["menuTimelineLabel"]);
  const status = plStatus(text(raw["status"]), text(timeline["status"]), report);
  const delivered = status === "delivered";
  return snapshot({
    carrier: "dhl",
    barcode: number,
    status,
    rawStatus: text(raw["status"]),
    delivered,
    deliveredAt: delivered ? isoTime(timeline["dateUtc"], { naive: "utc" }) : null,
    pickup: status === "at_pickup_point",
    sender: text(raw["sender"]),
    // The locker PIN never leaves the plug-in.
    raw: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "shipmentPin")),
  });
}

/** The own and the observed incoming lists, merged; the account lists no outgoing parcels. */
export async function fetchPlAccount(
  context: PluginContext<unknown, unknown>,
  signedIn: PlSignedIn,
): Promise<FetchResult> {
  const stored = storedSchema.safeParse(context.session.load());
  const base = fingerprint(signedIn.jar);
  const jar = restoreJar(
    stored.success && stored.data.base === base ? stored.data.jar : signedIn.jar,
  );
  try {
    const token = await bearer(context, signedIn, jar);
    const headers = { authorization: `Bearer ${token}` };
    const own = await plCall(context.http, "/user/shipment/v2.1/list/incoming/active/1", {
      method: "POST",
      headers,
      body: { shipmentFilterTypes: [], shipmentFilterStatuses: [], page: 1 },
    });
    const observed = await plCall(
      context.http,
      "/user/shipment/observed/v1.0/list/incoming/active",
      {
        method: "POST",
        headers,
        body: {},
      },
    );
    for (const answer of [own, observed]) {
      if (answer.status === 401 || answer.status === 403) {
        throw new SignInRejectedError("Mój DHL refused a freshly refreshed session.");
      }
    }
    if (own.status !== 200 || !isObject(own.body)) {
      throw new TransientError(`Mój DHL's inbox answered HTTP ${own.status}.`);
    }
    const merged = new Map<string, Json>();
    for (const item of [
      ...(observed.status === 200 ? asList(observed.body) : []),
      ...asList(own.body["shipments"]),
    ]) {
      const number = isObject(item) ? text(item["shipmentNumber"]) : null;
      if (number !== null && isObject(item)) {
        merged.set(number, item);
      }
    }
    const report = unknownReporter(context, "status_code");
    const snapshots = [...merged.values()]
      .map((raw) => accountSnapshot(raw, report))
      .filter((parcel): parcel is ParcelSnapshot => parcel !== null);
    // Only the active lists are read, so a parcel missing from them is not gone.
    return { snapshots, complete: false };
  } finally {
    await context.session.save({ base, jar: serializeJar(jar) });
  }
}
