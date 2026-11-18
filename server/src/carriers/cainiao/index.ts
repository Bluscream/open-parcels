import { z } from "zod";
import {
  asArray,
  asObject,
  defineCarrier,
  isObject,
  isoTime as kitIsoTime,
  lookUpStatus,
  newestFirst,
  requestJson,
  snapshot,
  text,
  UnexpectedResponseError,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { ACTION_STATUS } from "./status.js";

const CARRIER_ID = "cainiao";
const HOST = "global.cainiao.com";
const PLAUSIBLE = /^[A-Z0-9]{8,40}$/i;
/** Codes per request; the endpoint documents no limit, so stay small. */
export const BATCH_SIZE = 10;

/** Offset-less times are UTC; numbers are epoch milliseconds. */
const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "utc", epoch: "ms", keepFraction: true });

function mapAction(code: string | null, report?: (c: string) => void) {
  return lookUpStatus(ACTION_STATUS, code?.toUpperCase() ?? null, report);
}

/** One batch; returns the entries keyed by tracking number. Unknown numbers are left out. */
async function readBatch(http: PluginHttp, codes: readonly string[]): Promise<Map<string, Json>> {
  const url = new URL(`https://${HOST}/global/detail.json`);
  url.searchParams.set("mailNos", codes.join(","));
  url.searchParams.set("lang", "en-US");
  const body = await requestJson(http, url, "Cainiao tracking");
  if (!isObject(body) || !Array.isArray(body["module"])) {
    throw new UnexpectedResponseError("Cainiao tracking answered without a module list.");
  }
  if (body["success"] !== true) {
    throw new UnexpectedResponseError("Cainiao tracking reported a failed lookup.");
  }
  const found = new Map<string, Json>();
  for (const entry of asArray(body["module"])) {
    const code = text(asObject(entry)["mailNo"]);
    if (code !== null && isObject(entry)) {
      found.set(code, entry);
    }
  }
  return found;
}

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asArray(raw["detailList"])) {
    const event = asObject(entry);
    const at = isoTime(event["time"]);
    const code = text(event["actionCode"]);
    const rawStatus = text(event["standerdDesc"]) ?? text(event["desc"]) ?? code;
    if (at !== null && rawStatus !== null) {
      events.push({ at, rawStatus, status: mapAction(code), location: null });
    }
  }
  return newestFirst(events);
}

/** The status comes from the newest trace's action code, the specific vocabulary. */
export function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  const latest = asObject(raw["latestTrace"]);
  const events = history(raw);
  const latestCode = text(latest["actionCode"]);
  const status = latestCode !== null ? mapAction(latestCode, report) : (events[0]?.status ?? null);
  const delivered = status === "delivered";
  const eta = asObject(raw["globalEtaInfo"]);
  const plannedFrom = isoTime(eta["deliveryMinTime"]);
  const maxTime = isoTime(eta["deliveryMaxTime"]);
  const plannedTo = maxTime === plannedFrom ? null : maxTime;
  const barcode = text(raw["mailNo"]) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus:
      text(raw["statusDesc"]) ??
      text(latest["standerdDesc"]) ??
      text(latest["desc"]) ??
      text(raw["status"]),
    delivered,
    deliveredAt: delivered ? isoTime(latest["time"]) : null,
    plannedFrom: delivered ? null : plannedFrom,
    plannedTo: delivered ? null : plannedTo,
    pickup: status === "at_pickup_point",
    url: `https://${HOST}/detail.htm?mailNoList=${encodeURIComponent(barcode)}`,
    history: events,
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  const codes = barcodes.filter((code) => PLAUSIBLE.test(code));
  const snapshots: ParcelSnapshot[] = [];
  for (let start = 0; start < codes.length; start += BATCH_SIZE) {
    const batch = codes.slice(start, start + BATCH_SIZE);
    const found = await readBatch(context.http, batch);
    for (const code of batch) {
      const raw = found.get(code);
      // An entry without any events is "not scanned yet"; left out like an unknown code.
      if (
        raw !== undefined &&
        (asArray(raw["detailList"]).length > 0 || isObject(raw["latestTrace"]))
      ) {
        snapshots.push(toSnapshot(raw, code, report));
      }
    }
  }
  return { snapshots, complete: true };
}

export const cainiao = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Cainiao",
  countries: ["*"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
