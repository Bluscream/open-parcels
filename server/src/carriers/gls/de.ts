import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  CaptchaError,
  isObject,
  isoTime as kitIsoTime,
  parseJsonBody,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type PluginLogger,
  type SessionStore,
} from "../../plugin/api.js";
import { CARRIER_ID, compactPostcode, latestHistory, mapGls, publicUrl, text } from "./shared.js";

export const DE_IDENTITY_HOST = "api-backend.glsnxt.com";
export const DE_PARCEL_HOST = "gls-pakete-de-backend-app.ooh.glsnxt.com";
const IDENTITY = `https://${DE_IDENTITY_HOST}/ecosystem/user-service/v1/users`;
const TRACKINGS = `https://${DE_PARCEL_HOST}/api/v1/trackings`;

/** Renew this long before the token runs out: tokens live about 60 hours. */
const REFRESH_MARGIN_MS = 6 * 3_600_000;
const FALLBACK_LIFETIME_MS = 60 * 3_600_000;
/** Most parcel numbers remembered per source; the oldest are dropped first. */
const MAX_REMEMBERED = 200;

const stateSchema = z.object({
  instanceId: z.string().min(1),
  token: z.string().min(1).nullable(),
  expiresAt: z.number().nullable(),
  parcels: z.record(z.string(), z.string()),
});
type State = z.infer<typeof stateSchema>;

function stopOnCaptcha(response: HttpResponse): void {
  if (/recaptcha/i.test(response.body) || response.headers.has("x-recaptcha-token")) {
    throw new CaptchaError("GLS Germany asked for a captcha; the guest route may be closing.");
  }
}

function expiry(payload: Json, now: number): number {
  const read = (value: unknown): number | null => {
    const iso = kitIsoTime(value, { naive: "utc", epoch: "s" });
    return iso === null ? null : Date.parse(iso);
  };
  return read(payload["expiresAt"]) ?? now + FALLBACK_LIFETIME_MS;
}

/**
 * GLS Germany's app has no consumer account and no keyless route: the app mints its own
 * instance id, registers it, and trades it for a bearer token (validate is the one call that
 * needs none). A gone instance is registered anew, which empties the carrier-side list, so every
 * parcel is added again. A network error never registers anything.
 */
export class GlsGermany {
  #state: State | null;
  #changed = false;

  constructor(
    private readonly http: PluginHttp,
    private readonly logger: PluginLogger,
    private readonly now: () => number,
    stored: unknown,
  ) {
    const parsed = stateSchema.safeParse(asObject(stored)["de"]);
    this.#state = parsed.success ? parsed.data : null;
  }

  get state(): State | null {
    return this.#state;
  }

  async save(session: SessionStore): Promise<void> {
    if (this.#changed && this.#state !== null) {
      await session.save({ de: this.#state });
    }
  }

  async #identity(path: "register" | "validate", instanceId: string): Promise<Json | null> {
    const response = await this.http.request(new URL(`${IDENTITY}/${path}`), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ appInstanceId: instanceId }),
    });
    stopOnCaptcha(response);
    if (path === "validate" && response.status === 404) {
      return null;
    }
    if (response.status !== (path === "register" ? 201 : 200)) {
      throw new TransientError(`GLS Germany ${path} answered HTTP ${response.status}.`);
    }
    const payload = parseJsonBody(response.body);
    if (!isObject(payload) || text(payload["accessToken"]) === null) {
      throw new UnexpectedResponseError(`GLS Germany ${path} answered without a token.`);
    }
    return payload;
  }

  #store(instanceId: string, payload: Json, parcels: Record<string, string>): void {
    this.#state = {
      instanceId,
      token: text(payload["accessToken"]),
      expiresAt: expiry(payload, this.now()),
      parcels,
    };
    this.#changed = true;
  }

  async #register(): Promise<void> {
    const instanceId = randomUUID();
    const payload = await this.#identity("register", instanceId);
    if (payload === null) {
      throw new UnexpectedResponseError("GLS Germany register answered 404.");
    }
    if (this.#state !== null) {
      this.logger.warn({}, "GLS Germany forgot this app instance; registered a new one.");
    }
    this.#store(instanceId, payload, {});
  }

  async #refresh(): Promise<void> {
    if (this.#state === null) {
      await this.#register();
      return;
    }
    const payload = await this.#identity("validate", this.#state.instanceId);
    if (payload === null) {
      await this.#register();
      return;
    }
    this.#store(this.#state.instanceId, payload, this.#state.parcels);
  }

  async #token(): Promise<string> {
    const state = this.#state;
    if (
      state?.token === null ||
      state?.token === undefined ||
      state.expiresAt === null ||
      this.now() >= state.expiresAt - REFRESH_MARGIN_MS
    ) {
      await this.#refresh();
    }
    const token = this.#state?.token;
    if (token === null || token === undefined) {
      throw new UnexpectedResponseError("GLS Germany gave no token.");
    }
    return token;
  }

  async #call(url: URL, body?: Json): Promise<HttpResponse> {
    const send = async (token: string): Promise<HttpResponse> => {
      const response = await this.http.request(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          "accept-language": "de-DE",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      stopOnCaptcha(response);
      return response;
    };
    const first = await send(await this.#token());
    if (first.status !== 401) {
      return first;
    }
    // A refused token is renewed once; whatever the retry answers is final.
    await this.#refresh();
    return send(await this.#token());
  }

  #remember(reference: string, parcelNumber: string): void {
    if (this.#state === null) {
      return;
    }
    const entries = Object.entries(this.#state.parcels).filter(([key]) => key !== reference);
    entries.push([reference, parcelNumber]);
    const parcels = Object.fromEntries(entries.slice(-MAX_REMEMBERED));
    this.#state = { ...this.#state, parcels };
    this.#changed = true;
  }

  /**
   * One parcel: added (with the postcode) the first time, which answers its details; read by
   * GLS's parcel number afterwards, because adding it again only answers 409.
   */
  async parcel(reference: string, postcode: string): Promise<Json | null> {
    const known = this.#state?.parcels[reference];
    if (known !== undefined) {
      const instance = this.#state?.instanceId;
      const response = await this.#call(new URL(`${TRACKINGS}/${encodeURIComponent(known)}`));
      // A new instance has an empty list: the parcel is added to it below.
      if (this.#state?.instanceId === instance) {
        return this.#read(reference, response);
      }
    }
    const added = await this.#call(new URL(TRACKINGS), {
      trackingReference: reference,
      postcode: compactPostcode(postcode),
    });
    return this.#read(reference, added);
  }

  #read(reference: string, response: HttpResponse): Json | null {
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      throw new TransientError(`GLS Germany answered HTTP ${response.status}.`);
    }
    const payload = parseJsonBody(response.body);
    if (!isObject(payload)) {
      throw new UnexpectedResponseError("GLS Germany answered without a parcel.");
    }
    const number = text(payload["parcelNumber"]);
    if (number !== null) {
      this.#remember(reference, number);
    }
    return payload;
  }
}

/** German timestamps are `YYYY-MM-DD HH:MM:SS` without an offset, read as UTC as the app does. */
const deTime = (value: unknown): string | null => kitIsoTime(value, { naive: "utc" });

/**
 * The status is derived first: a delivery date means delivered, a failed attempt a problem.
 * Otherwise the latest text decides, only where the shared table knows it.
 */
export function deSnapshot(
  raw: Json,
  reference: string,
  report: (text: string) => void,
): ParcelSnapshot {
  const rows = asList(raw["deliveryEvents"]).filter(isObject);
  const rawStatus = text(raw["latestStatusText"]) ?? text(rows[0]?.["description"]);
  const deliveredAt = deTime(raw["deliveredAt"]);
  const textStatus = mapGls(null, rawStatus)?.status ?? null;
  if (rawStatus !== null && textStatus === null && deliveredAt === null) {
    report(rawStatus);
  }
  const status =
    deliveredAt === null
      ? raw["hasDeliveryAttemptFailed"] === true
        ? "problem"
        : textStatus
      : "delivered";
  const shop = raw["shopInformation"];
  const pickup = isObject(shop) || text(shop) !== null;
  const number = text(raw["parcelNumber"]) ?? reference;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["trackingReference"]) ?? reference,
    status,
    rawStatus,
    delivered: deliveredAt !== null,
    deliveredAt,
    pickup,
    pickupPoint: isObject(shop) ? text(shop["name"]) : text(shop),
    url: publicUrl(number),
    sender: text(asObject(raw["senderInformation"])["name"]),
    receiver: text(raw["recipientName"]) ?? text(asObject(raw["consigneeInformation"])["name"]),
    // Event texts follow the language asked for; they are never read for a status.
    history: latestHistory(
      rows.flatMap((row) => {
        const at = deTime(row["occurrenceDateTime"]);
        const description = text(row["description"]);
        return at === null || description === null
          ? []
          : [{ at, rawStatus: description, status: null, location: null }];
      }),
    ),
    raw,
  });
}
