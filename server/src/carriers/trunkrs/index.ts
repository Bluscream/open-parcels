import { z } from "zod";
import type { PluginHttp } from "../../plugin/api.js";
import {
  carrierPattern,
  ruleStatus,
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";
import {
  asObject,
  expectStatus,
  isObject,
  isoTime,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/api.js";

/** Offset-less timestamps are the carrier's local time; numbers are epoch ms. */
const LOCAL_TIME = { naive: { zone: "Europe/Amsterdam" }, epoch: "ms" } as const;

const CARRIER_ID = "trunkrs";
const API_HOST = "api.trunkrs.app";

const BARCODE_PATTERN = carrierPattern("trunkrs");

const configSchema = z.looseObject({
  /** The receiver's postcode. Trunkrs only answers for a parcel number together with it. */
  postalCode: z.string().min(1),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

export function normalizePostcode(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * The parcel number and postcode are sent as HTTP Basic credentials; together they name one
 * parcel. A refused pair is "no such parcel" for a tracking source, never a sign-in problem.
 */
async function lookUp(http: PluginHttp, barcode: string, postcode: string): Promise<Json | null> {
  const pair = Buffer.from(`${barcode}:${postcode}`).toString("base64");
  const response = await http.request(new URL(`https://${API_HOST}/v2/tracing/details`), {
    headers: { accept: "application/json", authorization: `Basic ${pair}` },
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return null;
  }
  expectStatus(response, "Trunkrs", 200);
  if (response.body.trim() === "") {
    return null;
  }
  const payload = readJson(response, "Trunkrs");
  return isObject(payload) ? payload : null;
}

function mapState(state: string | null): NonNullable<ParcelSnapshot["status"]> | null {
  return ruleStatus(CARRIER_ID, state);
}

/** History from the delivery attempts; the audit log names drivers and is never read. */
function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const attempt of objects(raw["deliveryAttempts"])) {
    const at = isoTime(attempt["setAt"], LOCAL_TIME);
    const state = text(attempt["stateName"]);
    if (at !== null && state !== null) {
      events.push({ at, status: mapState(state), rawStatus: state, location: null });
    }
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function trunkrsSnapshot(
  raw: Json,
  barcode: string,
  postcode: string,
  report: (state: string) => void,
): ParcelSnapshot {
  const current = asObject(raw["currentState"]);
  const state = text(current["stateName"]);
  const status = mapState(state);
  if (state !== null && status === null) {
    report(state);
  }
  const delivered = state === "SHIPMENT_DELIVERED";
  // The narrow live window once the tour is planned, otherwise the wide promised slot.
  const slot = asObject(raw["timeSlot"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: state,
    delivered,
    deliveredAt: delivered ? isoTime(current["setAt"], LOCAL_TIME) : null,
    plannedFrom: delivered ? null : isoTime(slot["from"] ?? slot["low"], LOCAL_TIME),
    plannedTo: delivered ? null : isoTime(slot["to"] ?? slot["high"], LOCAL_TIME),
    url: rulesTrackingUrl(CARRIER_ID, barcode, undefined, { postcode }),
    sender: text(raw["senderName"]) ?? text(raw["merchantName"]),
    receiver: text(raw["recipientName"]),
    history: history(raw),
    raw: { ...raw, auditLogs: undefined },
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const postcode = normalizePostcode(context.config.postalCode);
  const snapshots: ParcelSnapshot[] = [];
  const report = (state: string): void => {
    context.reportUnknown("state", state);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode, postcode);
    if (raw !== null) {
      snapshots.push(trunkrsSnapshot(raw, barcode, postcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const trunkrs = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Trunkrs",
  countries: ["NL", "BE"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [API_HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
