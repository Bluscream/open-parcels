import { z } from "zod";
import type { PluginHttp } from "../../plugin/api.js";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  asObject,
  carrierKey,
  isObject,
  ruleStatus,
  isoTime,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/api.js";

const CARRIER_ID = "uniuni";
const API_HOST = "delivery-api.uniuni.ca";
/** The key UniUni's own public tracking page sends; it identifies no user. */
const publicKey = (): string => carrierKey(CARRIER_ID, "public_key");

type Status = NonNullable<ParcelSnapshot["status"]>;

const BARCODE_PATTERN = carrierPattern("uniuni");

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

/** The parcel record, or null when UniUni does not know the code. */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${API_HOST}/cargo/trackinguniuninew`);
  url.searchParams.set("id", barcode);
  url.searchParams.set("key", publicKey());
  url.searchParams.set("source", "web");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200 && response.status !== 400) {
    throw new TransientError(`UniUni answered HTTP ${response.status}.`);
  }
  const payload = readJson(response, "UniUni");
  if (response.status === 400) {
    // A 400 about the key means the public key was rotated; anything else is unexpected too.
    throw new UnexpectedResponseError("UniUni refused the public tracking request.");
  }
  const records = asObject(asObject(payload)["data"])["valid_tno"];
  if (!Array.isArray(records)) {
    throw new UnexpectedResponseError("UniUni answered without a record list.");
  }
  const first: unknown = records.find(isObject);
  return isObject(first) ? first : null;
}

function mapState(code: string | null): Status | null {
  return ruleStatus(CARRIER_ID, code);
}

/** `ts` is epoch seconds; some late events carry only the local time and the zone name. */
function eventTime(dateTime: Json): string | null {
  const fromTs =
    typeof dateTime["ts"] === "number"
      ? isoTime(dateTime["ts"], { naive: "runtime", epoch: "s" })
      : null;
  if (fromTs !== null) {
    return fromTs;
  }
  const zone = text(dateTime["timezone"]);
  if (zone === null) {
    return null;
  }
  try {
    return isoTime(dateTime["localTime"], { naive: { zone }, dateOnly: false });
  } catch {
    // An unknown zone name: the event has no anchor and is left out.
    return null;
  }
}

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of objects(raw["spath_list"])) {
    const at = eventTime(asObject(entry["dateTime"]));
    const code = text(entry["state"]);
    const rawStatus = text(entry["description_en"]) ?? code;
    if (at !== null && rawStatus !== null) {
      events.push({ at, status: mapState(code), rawStatus, location: null });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function uniuniSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const code = text(raw["state"]);
  const status = mapState(code);
  if (code !== null && status === null) {
    report(code);
  }
  const events = history(raw);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["tno"]) ?? barcode,
    status,
    rawStatus: code,
    delivered,
    // UniUni has no separate delivery time; the delivered event is the anchor.
    deliveredAt: delivered
      ? (events.find((event) => event.status === "delivered")?.at ?? null)
      : null,
    pickup: status === "at_pickup_point",
    history: events,
    raw,
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("state", code);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(uniuniSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const uniuni = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "UniUni",
  countries: ["CA", "US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [API_HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
