import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { asObject, isObject, objects, readJson, text, type Json } from "../../plugin/kit/json.js";
import { newestFirst, zonedIso } from "../../plugin/kit/time.js";
import {
  expectOk,
  lookUpStatus,
  trackEach,
  unknownReporter,
  type StatusTable,
} from "../../plugin/kit/track.js";

const CARRIER_ID = "elta_courier";
const HOST = "www.elta-courier.gr";
const ZONE = "Europe/Athens";

/** ELTA Courier reports Greek sentences; each is matched exactly. */
const STATUSES: StatusTable = {
  "Δημιουργία ΣΥ.ΔΕ.ΤΑ.": "registered",
  "Αποστολή βρίσκεται σε στάδιο μεταφοράς": "in_transit",
  "Άφιξη σε": "in_transit",
  "Σε διανομέα προς παράδοση": "out_for_delivery",
  "Αποστολή παραδόθηκε": "delivered",
};

const PLAUSIBLE = /^[A-Z0-9]{8,30}$/;

/**
 * Looks one code up. The answer is keyed by the code; a single entry under a differently
 * spelled key is accepted as the same parcel. No entry, or one without events, is "not found".
 */
async function lookUp(http: PluginHttp, code: string): Promise<Json[] | null> {
  const response = await http.request(new URL(`https://${HOST}/track.php`), {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ number: code }),
  });
  expectOk(response, "ELTA Courier tracking");
  const results = asObject(readJson(response, "ELTA Courier tracking"))["result"];
  if (!isObject(results)) {
    return null;
  }
  const entries = Object.values(results);
  const parcel = results[code] ?? (entries.length === 1 ? entries[0] : undefined);
  const events = asObject(parcel)["result"];
  return Array.isArray(events) ? objects(events) : null;
}

/** `18-11-2026` and `09:15`, local Greek time. */
function eventTime(event: Json): string | null {
  const date = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text(event["date"]) ?? "");
  const time = /^(\d{1,2}):(\d{2})$/.exec(text(event["time"]) ?? "");
  if (date === null || time === null) {
    return null;
  }
  return zonedIso(
    [Number(date[3]), Number(date[2]), Number(date[1]), Number(time[1]), Number(time[2]), 0],
    ZONE,
  );
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = eventTime(event);
    const rawStatus = text(event["status"]);
    if (at !== null && rawStatus !== null) {
      result.push({
        at,
        rawStatus,
        status: lookUpStatus(STATUSES, rawStatus),
        location: text(event["place"]),
      });
    }
  }
  return newestFirst(result);
}

function toSnapshot(
  events: readonly Json[],
  barcode: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const entries = history(events);
  const newest = entries[0];
  const status = newest?.status ?? null;
  if (newest !== undefined && status === null) {
    report(newest.rawStatus);
  }
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: newest?.rawStatus ?? null,
    deliveredAt: status === "delivered" ? (newest?.at ?? null) : null,
    // The site has no deep link per code; the form is the closest a user gets.
    url: `https://${HOST}/track`,
    history: entries,
    raw: events.map((event) => ({
      date: event["date"],
      time: event["time"],
      place: event["place"],
      status: event["status"],
    })),
  });
}

async function track(context: PluginContext<unknown, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const events = await lookUp(context.http, code);
    return events === null ? null : toSnapshot(events, tracked, report);
  });
}

/** ELTA Courier (Greece): the public tracking form. */
export const eltaCourier = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "ELTA Courier",
  countries: ["GR"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
