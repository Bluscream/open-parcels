import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  isObject,
  isoTime,
  newestFirst,
  parseJsonBody,
  SignInRejectedError,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { stepStatus } from "./status.js";

export const ACCOUNT_HOST = "mybpost.bpost.cloud";
const API = `https://${ACCOUNT_HOST}/prod_v2`;
const ZONE = "Europe/Brussels";
const HISTORY_LIMIT = 20;

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

const tokensSchema = z.object({ access: z.string().min(1), refresh: z.string().min(1) });
type Tokens = z.infer<typeof tokensSchema>;

/** The app refused a token (HTTP 401/403). */
class Refused extends Error {
  override readonly name = "Refused";
}

function tokensFrom(payload: unknown): Tokens {
  const response = asObject(asObject(payload)["response"]);
  const access = text(response["accessToken"]) ?? text(response["token"]);
  const refresh = text(response["refreshToken"]);
  if (access === null || refresh === null) {
    throw new UnexpectedResponseError("My bpost answered a sign-in without tokens.");
  }
  return { access, refresh };
}

/**
 * The My bpost app's backend. Every call carries the app's key and version (in the shared
 * rules); a refused key or version is the app's compatibility, never the user's sign-in. Tokens
 * rotate on refresh and are saved at once; a refused refresh signs in again with the stored
 * password, a network error never does.
 */
class Account {
  #tokens: Tokens | null;

  constructor(private readonly context: PluginContext<unknown, Credentials>) {
    const stored = tokensSchema.safeParse(context.session.load());
    this.#tokens = stored.success ? stored.data : null;
  }

  async #post(
    path: string,
    body: Json,
    options: { auth: boolean; app: boolean },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "x-api-key": carrierKey("bpost", "app_key"),
      "content-type": "application/json",
      os: "android",
      osVersion: "14",
    };
    if (options.app) {
      headers["appVersion"] = carrierKey("bpost", "app_version");
      headers["appLang"] = "en";
    }
    if (options.auth && this.#tokens !== null) {
      headers["authorization"] = this.#tokens.access;
    }
    const response = await this.context.http.request(new URL(`${API}/${path}`), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const payload = parseJsonBody(response.body);
    if (response.status === 401 || response.status === 403) {
      if (text(asObject(payload)["code"]) === "APPVERSION_NOT_SUPPORTED" || !isObject(payload)) {
        this.context.logger.warn({ path }, "My bpost refused the app's key or version.");
        throw new TransientError("My bpost no longer accepts this app version or key.");
      }
      throw new Refused(path);
    }
    if (response.status !== 200 || payload === null) {
      throw new TransientError(`My bpost ${path} answered HTTP ${response.status}.`);
    }
    return payload;
  }

  async #store(tokens: Tokens): Promise<void> {
    this.#tokens = tokens;
    await this.context.session.save(tokens);
  }

  async #signIn(): Promise<void> {
    try {
      const payload = await this.#post(
        "users/login",
        {
          userName: this.context.secret.username,
          password: this.context.secret.password,
          appLang: "en",
          mandatoryConsent: true,
          optionalConsent: false,
        },
        { auth: false, app: true },
      );
      await this.#store(tokensFrom(payload));
    } catch (error) {
      if (error instanceof Refused) {
        throw new SignInRejectedError("My bpost rejected the e-mail address or password.");
      }
      throw error;
    }
  }

  async #renew(): Promise<void> {
    if (this.#tokens === null) {
      await this.#signIn();
      return;
    }
    try {
      const payload = await this.#post(
        "users/refreshtoken",
        { refreshToken: this.#tokens.refresh },
        { auth: false, app: false },
      );
      await this.#store(tokensFrom(payload));
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
      await this.#signIn();
    }
  }

  /** One signed-in call; a refused token is renewed once. */
  async call(path: string, body: Json): Promise<unknown> {
    if (this.#tokens === null) {
      await this.#signIn();
    }
    try {
      return await this.#post(path, body, { auth: true, app: true });
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
    }
    await this.#renew();
    try {
      return await this.#post(path, body, { auth: true, app: true });
    } catch (error) {
      throw error instanceof Refused
        ? new SignInRejectedError("My bpost refused a freshly renewed session.")
        : error;
    }
  }
}

/** `{day|date, time}` in Brussels time. */
function localTime(value: unknown, fallback = "00:00"): string | null {
  const entry = asObject(value);
  const day = text(entry["day"]) ?? text(entry["date"]);
  return day === null
    ? null
    : isoTime(`${day}T${text(entry["time"]) ?? fallback}`, { naive: { zone: ZONE } });
}

function currentStatus(raw: Json): string | null {
  for (const key of ["currentStatus", "parcelMainStatus", "status"]) {
    const value = text(raw[key]);
    if (value !== null) {
      return value;
    }
  }
  const active = asList(raw["deliverySteps"])
    .filter(isObject)
    .find((step) => step["status"] === "active");
  return (
    text(active?.["knownProcessStep"]) ?? text(active?.["name"]) ?? text(raw["parcelActiveStatus"])
  );
}

export function accountSnapshot(raw: Json, report: (key: string) => void): ParcelSnapshot | null {
  const barcode = text(raw["itemCode"]) ?? text(raw["senderBarcode"]) ?? text(raw["itemId"]);
  if (barcode === null) {
    return null;
  }
  const rawStatus = currentStatus(raw);
  const status = stepStatus(rawStatus, null, report);
  const deliveredAt = localTime(raw["actualDeliveryTime"]);
  const delivered = deliveredAt !== null || status === "delivered";
  const eta = asObject(raw["eta"]);
  const point = raw["deliveryPoint"];
  const details = asObject(raw["viewParcelDetails"]);
  const grams = raw["weightInGrams"] ?? details["weightInGrams"];
  const day = text(eta["day"]);
  return snapshot({
    carrier: "bpost",
    barcode,
    direction: ["SENDER", "SHIPPER", "OUTGOING"].includes(
      (text(raw["userType"]) ?? "").toUpperCase(),
    )
      ? "outgoing"
      : "incoming",
    status,
    rawStatus,
    delivered,
    deliveredAt,
    plannedFrom:
      delivered || day === null ? null : localTime({ day, time: text(eta["time1"]) ?? "00:00" }),
    plannedTo:
      delivered || day === null ? null : localTime({ day, time: text(eta["time2"]) ?? "23:59:59" }),
    pickup: isObject(point) || status === "at_pickup_point",
    pickupPoint: isObject(point) ? text(point["name"]) : null,
    url: `https://track.bpost.cloud/btr/web/#/search?lang=en&itemCode=${encodeURIComponent(barcode)}`,
    sender: text(asObject(raw["sender"])["name"]),
    receiver: text(asObject(raw["receiver"])["name"]),
    weightKg: typeof grams === "number" && grams > 0 ? grams / 1000 : null,
    history: newestFirst(
      asList(raw["events"])
        .filter(isObject)
        .flatMap((event) => {
          const at = localTime(event);
          const key =
            text(event["key"]) ?? text(asObject(asObject(event["key"])["EN"])["description"]);
          return at === null || key === null
            ? []
            : [{ at, rawStatus: key, status: null, location: null }];
        }),
    ).slice(0, HISTORY_LIMIT),
    raw,
  });
}

/** The inbox: summaries first (`Err_1005` is an empty inbox), then their details in one call. */
export async function fetchBpostAccount(
  context: PluginContext<unknown, Credentials>,
): Promise<FetchResult> {
  const account = new Account(context);
  const list = asObject(await account.call("parcel/getparcelslist", { appLang: "en" }));
  if (list["dbError"] === "Err_1005") {
    return { snapshots: [], complete: true };
  }
  const items = asObject(list["response"] ?? list)["items"] ?? [];
  if (!Array.isArray(items)) {
    throw new UnexpectedResponseError("My bpost's parcel list has an unexpected shape.");
  }
  const summaries = items.filter(isObject).filter((item) => text(item["itemCode"]) !== null);
  if (summaries.length === 0) {
    return { snapshots: [], complete: true };
  }
  const detail = asObject(
    asObject(
      await account.call("parcel/getparcelsv3", {
        appLang: "en",
        isFirstPageCall: true,
        items: summaries.map((item) => ({
          itemCode: item["itemCode"],
          Status: item["Status"] ?? null,
          LatestEventTimestamp: item["LatestEventTimestamp"] ?? null,
        })),
      }),
    )["response"],
  );
  const entries = [
    ...Object.values(asObject(detail["active"])).flatMap((group) => asList(group).filter(isObject)),
    ...asList(detail["history"]).filter(isObject),
  ];
  const report = unknownReporter(context, "status_code");
  const snapshots = entries
    .map((raw) => accountSnapshot(raw, report))
    .filter((parcel): parcel is ParcelSnapshot => parcel !== null);
  // The details call is the app's first page (`isFirstPageCall`) and how it pages further is not
  // known, so the answer may be partial: it never lets a parcel missing from it count as gone.
  return { snapshots, complete: false };
}
