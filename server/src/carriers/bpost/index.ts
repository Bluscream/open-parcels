import { z } from "zod";
import {
  carrierPattern,
  type PluginHttp,
  asArray,
  asObject,
  defineCarrier,
  isObject,
  newestFirst,
  InvalidConfigError,
  readObject,
  SignInRejectedError,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { ACCOUNT_HOST, fetchBpostAccount, type Credentials } from "./account.js";
import { stepStatus } from "./status.js";

const CARRIER_ID = "bpost";
const HOST = "track.bpost.cloud";
const ZONE = "Europe/Brussels";
const PLAUSIBLE = carrierPattern("bpost");
const LANGUAGES = ["en", "nl", "fr"] as const;
type Language = (typeof LANGUAGES)[number];

/** bpost's error values for an unknown barcode and postcode pair. */
const NOT_FOUND = /^(NO_DATA_FOUND|ITEM_NOT_FOUND|NOT_FOUND)$/i;

/** Looks a barcode up with the recipient's postcode; without it bpost withholds most fields. */
async function lookUp(http: PluginHttp, barcode: string, postalCode: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/track/items`);
  url.searchParams.set("itemIdentifier", barcode);
  url.searchParams.set("postalCode", postalCode);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`bpost tracking answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "bpost tracking");
  // An unknown pair is a 200 with a not-found `error`, or an empty item list. Any other error is
  // a failure, never a code that reads as not found.
  if ("error" in payload) {
    if (NOT_FOUND.test(text(payload["error"]) ?? "")) {
      return null;
    }
    throw new UnexpectedResponseError("bpost tracking answered with an error it does not explain.");
  }
  if (!Array.isArray(payload["items"])) {
    throw new UnexpectedResponseError("bpost tracking answered without its item list.");
  }
  const item = asArray(payload["items"])[0];
  return isObject(item) ? item : null;
}

/** "2026-11-18" plus an optional "13:06" (or "13:06:00"), as Brussels time. */
function localTime(day: unknown, time: unknown, fallback = "00:00"): string | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(day) ?? "");
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text(time) ?? fallback);
  if (date === null || clock === null) {
    return null;
  }
  return zonedIso(
    {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: Number(clock[3] ?? "0"),
    },
    ZONE,
  );
}

/** Text in the chosen language, falling back to English. */
function localized(node: unknown, language: Language): string | null {
  const texts = asObject(node);
  return (
    text(asObject(texts[language.toUpperCase()])["description"]) ??
    text(asObject(texts["EN"])["description"])
  );
}

function history(item: Json, language: Language): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asArray(item["events"])) {
    const event = asObject(entry);
    const at = localTime(event["date"], event["time"]);
    const rawStatus = localized(event["key"], language);
    if (at !== null && rawStatus !== null) {
      // Events carry no code of their own on this route.
      events.push({ at, rawStatus, status: null, location: null });
    }
  }
  return newestFirst(events);
}

/** `{day, time1, time2}` in Brussels time; a missing bound stretches to that end of the day. */
function plannedWindow(item: Json): { from: string | null; to: string | null } {
  const range = asObject(item["expectedDeliveryTimeRange"]);
  return {
    from: localTime(range["day"], text(range["time1"]) ?? "00:00"),
    to: localTime(range["day"], text(range["time2"]) ?? "23:59:59"),
  };
}

export interface BpostInput {
  readonly item: Json;
  readonly barcode: string;
  readonly postalCode: string;
  readonly language: Language;
}

export function bpostSnapshot(input: BpostInput, report: (key: string) => void): ParcelSnapshot {
  const { item, barcode, postalCode, language } = input;
  const step = asObject(item["activeStep"]);
  const knownStep = text(step["knownProcessStep"]);
  const status = stepStatus(knownStep, text(step["name"]), report);
  // Only the delivery record is reliable for "delivered": the step name varies by method.
  const deliveredTime = asObject(asObject(item["actualDeliveryInformation"])["actualDeliveryTime"]);
  const delivered = text(deliveredTime["day"]) !== null;
  const window = delivered ? { from: null, to: null } : plannedWindow(item);
  const point = item["deliveryPoint"];
  const grams = item["weightInGrams"];
  const url = new URL(`https://${HOST}/btr/web/`);
  url.hash = `/search?lang=${language}&itemCode=${encodeURIComponent(barcode)}&postalCode=${encodeURIComponent(postalCode)}`;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: knownStep ?? text(step["name"]),
    delivered,
    deliveredAt: delivered ? localTime(deliveredTime["day"], deliveredTime["time"]) : null,
    plannedFrom: window.from,
    plannedTo: window.to,
    // bpost names the pickup point as soon as the parcel is routed there.
    pickup: isObject(point) || status === "at_pickup_point",
    pickupPoint: isObject(point) ? text(point["name"]) : null,
    url: url.toString(),
    sender: text(item["senderCommercialName"]) ?? text(asObject(item["sender"])["name"]),
    receiver:
      text(asObject(item["receiver"])["name"]) ?? text(asObject(item["announcedReceiver"])["name"]),
    weightKg: typeof grams === "number" && grams > 0 ? grams / 1000 : null,
    history: history(item, language),
    raw: item,
  });
}

const configSchema = z.looseObject({
  postalCode: z
    .string()
    .regex(/^[A-Z0-9 -]{3,10}$/i)
    .optional()
    .describe("The recipient's postcode; bpost's tracking needs it with every barcode."),
  language: z.enum(LANGUAGES).default("en").describe("Language of bpost's event texts."),
});
const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();
type Config = z.infer<typeof configSchema>;
type Secret = Credentials | null;

export const bpost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "bpost",
  countries: ["BE"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [
    { type: "credentials", kinds: ["account"] },
    { type: "none", kinds: ["tracking"] },
  ],
  http: {
    limits: {
      [HOST]: { intervalMs: 5_000, burst: 2 },
      [ACCOUNT_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount: async (context) => {
    const secret = context.secret;
    if (secret === null) {
      throw new SignInRejectedError("The My bpost account needs an e-mail address and password.");
    }
    return await fetchBpostAccount({ ...context, secret });
  },
  track: (context: PluginContext<Config, Secret>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const postalCode = context.config.postalCode;
      if (postalCode === undefined) {
        throw new InvalidConfigError(
          "bpost's tracking needs the recipient's postcode in the source.",
        );
      }
      const item = await lookUp(context.http, barcode, postalCode);
      return item === null
        ? null
        : bpostSnapshot(
            {
              item,
              barcode,
              postalCode,
              language: context.config.language,
            },
            (key) => {
              context.reportUnknown("status_code", key);
            },
          );
    }),
});
