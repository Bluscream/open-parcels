import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  carrierPattern,
  defineCarrier,
  isObject,
  mayHaveMorePages,
  isoTime,
  newestFirst,
  num,
  parseJsonBody,
  RateLimitedError,
  readObject,
  snapshot,
  SignInRejectedError,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { B2C_HOST, pinSignIn, PplAccount, type Secret } from "./account.js";
import { API_HOST, CARRIER_ID, HISTORY_LIMIT, mapPpl, publicUrl } from "./shared.js";

const PLAUSIBLE = carrierPattern(CARRIER_ID);
const ZONE = "Europe/Prague";
const NOT_FOUND = "service.TrackAndTrace.ShipmentNotFound";
const SENDER_ADDRESS = 4;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.object({ email: z.string().min(1), password: z.string().min(1) }).nullable();

const when = (value: unknown): string | null =>
  isoTime(value, { naive: { zone: ZONE }, epoch: "ms" });

/**
 * The website's own lookup: one POST per number with an empty JSON body (required) and the
 * website's key (in the shared rules). Not found is a 400 with a specific `detail`; any other 400
 * is a broken request and stops the run.
 */
export async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(
    new URL(`https://${API_HOST}/ecs/ppl/webapi/TrackAndTrace/${encodeURIComponent(code)}`),
    {
      method: "POST",
      headers: {
        "dhl-api-key": carrierKey(CARRIER_ID, "website_key"),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
    },
  );
  if (response.status === 400) {
    if (text(asObject(parseJsonBody(response.body))["detail"]) === NOT_FOUND) {
      return null;
    }
    throw new UnexpectedResponseError("PPL refused the tracking request.");
  }
  if (response.status !== 200) {
    throw new TransientError(`PPL tracking answered HTTP ${response.status}.`);
  }
  return readObject(response, "PPL tracking");
}

function history(
  events: readonly Json[],
  at: string,
  code: string,
  label: string,
): SnapshotEvent[] {
  return newestFirst(
    events.flatMap((event) => {
      const time = when(event[at]);
      const eventCode = text(event[code]);
      const rawStatus = eventCode ?? text(event[label]);
      return time === null || rawStatus === null
        ? []
        : [{ at: time, rawStatus, status: mapPpl(eventCode)?.status ?? null, location: null }];
    }),
  ).slice(0, HISTORY_LIMIT);
}

const RAW_FIELDS = ["phase", "lastEventCode", "lastEventText", "packagesInSet", "isBackToSender"];

export function trackingSnapshot(
  raw: Json,
  code: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const statusCode = text(raw["phase"]) ?? text(raw["lastEventCode"]);
  const mapped = mapPpl(statusCode);
  if (statusCode !== null && mapped === null) {
    report(statusCode);
  }
  const status = mapped?.status ?? null;
  const delivered = status === "delivered";
  const sender = asList(raw["addresses"])
    .filter(isObject)
    .find((entry) => entry["type"] === SENDER_ADDRESS || entry["type"] === "SENDER");
  const point = asObject(raw["accessPoint"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: statusCode,
    delivered,
    deliveredAt: delivered ? when(raw["lastEventDate"]) : null,
    plannedFrom: delivered ? null : when(raw["expectedDeliveryDate"]),
    pickup: status === "at_pickup_point",
    pickupPoint: text(point["parcelshopName"]) ?? text(point["name"]),
    url: publicUrl(code),
    sender: text(sender?.["name"]),
    weightKg: num(raw["weight"]),
    history: history(asList(raw["events"]).filter(isObject), "eventDate", "code", "eventText"),
    // Addresses and the access point's location stay out of what is stored.
    raw: Object.fromEntries(RAW_FIELDS.filter((key) => key in raw).map((key) => [key, raw[key]])),
  });
}

async function track(context: PluginContext<Config, Secret | null>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : trackingSnapshot(raw, code, report);
  });
}

function direction(raw: Json): "incoming" | "outgoing" {
  const discriminator = (text(raw["discriminator"]) ?? "").toLowerCase();
  if (discriminator.includes("outgoing")) {
    return "outgoing";
  }
  if (discriminator.includes("incoming")) {
    return "incoming";
  }
  return "recipient" in raw && !("sender" in raw) ? "outgoing" : "incoming";
}

/** One shipment's events; a failed lookup costs history only, a refusal or limit stops the run. */
async function events(account: PplAccount, id: string): Promise<Json[]> {
  try {
    const payload = parseJsonBody(
      (await account.get(`/api/v1/me/shipments/${encodeURIComponent(id)}/events`)).body,
    );
    const list: readonly unknown[] = Array.isArray(payload)
      ? payload
      : asList(asObject(payload)["items"]);
    return list.filter(isObject);
  } catch (error) {
    if (
      error instanceof SignInRejectedError ||
      error instanceof RateLimitedError ||
      !(error instanceof TransientError)
    ) {
      throw error;
    }
    return [];
  }
}

export function accountSnapshot(
  raw: Json,
  timeline: readonly Json[],
  report: (key: string) => void,
): ParcelSnapshot | null {
  const number = text(raw["number"]);
  if (number === null) {
    return null;
  }
  const code = text(raw["lastShipmentEvent"]);
  const status = mapPpl(code)?.status ?? null;
  if (code !== null && status === null) {
    report(code);
  }
  const entries = history(timeline, "createdAt", "event", "message");
  const delivered = status === "delivered";
  const way = direction(raw);
  const point = asObject(raw["toDeliveryPoint"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: number,
    direction: way,
    status,
    rawStatus: code,
    delivered,
    deliveredAt: delivered
      ? (entries.find((event) => event.status === "delivered")?.at ?? null)
      : null,
    pickup: status === "at_pickup_point",
    pickupPoint: text(point["name"]),
    url: publicUrl(number),
    sender: way === "incoming" ? text(raw["sender"]) : null,
    receiver: way === "outgoing" ? text(raw["recipient"]) : null,
    history: entries,
    raw: { lastShipmentEvent: code, discriminator: raw["discriminator"] ?? null },
  });
}

async function fetchAccount(context: PluginContext<Config, Secret | null>) {
  const secret = context.secret;
  if (secret === null) {
    throw new SignInRejectedError("The mojePPL account needs a sign-in.");
  }
  const account = new PplAccount({ ...context, secret });
  const report = unknownReporter(context, "status_code");
  try {
    const envelope = readObject(
      await account.get("/api/v2/me/shipments?shipment_type=ALL"),
      "PPL shipments",
    );
    const items = envelope["items"];
    if (!Array.isArray(items)) {
      throw new UnexpectedResponseError("PPL's shipment list has no items.");
    }
    // Paging is not documented: a list that says it holds more is not everything.
    let complete = !mayHaveMorePages(envelope, items.length);
    const snapshots: ParcelSnapshot[] = [];
    for (const raw of items.filter(isObject)) {
      const id = text(raw["id"]);
      const timeline = id === null ? [] : await events(account, id);
      const parcel = accountSnapshot(raw, timeline, report);
      if (parcel === null) {
        complete = false;
      } else {
        snapshots.push(parcel);
      }
    }
    return { snapshots, complete };
  } finally {
    await account.save();
  }
}

/** PPL (Czechia): the website's tracking and the mojePPL app account. */
export const pplCz = defineCarrier<Config, Secret | null>({
  id: CARRIER_ID,
  name: "PPL CZ",
  countries: ["CZ"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [pinSignIn<Config>(), { type: "none", kinds: ["tracking"] }],
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [B2C_HOST]: { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  fetchAccount,
});
