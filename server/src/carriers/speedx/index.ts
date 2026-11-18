import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/api.js";
import { flightEvents } from "./flight.js";
import { CARRIER_ID, eventsSnapshot, type Json } from "./parse.js";

const HOST = "tracking.speedx.io";
const CODE_PATTERN = carrierPattern("speedx");

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/** The full history from the tracking page; undefined when the page lost its flight data. */
async function pageEvents(http: PluginHttp, code: string): Promise<Json[] | null | undefined> {
  const response = await http.request(new URL(`https://${HOST}/${encodeURIComponent(code)}`), {
    headers: { accept: "text/html" },
  });
  if (response.status !== 200) {
    throw new TransientError(`SpeedX page answered HTTP ${response.status}.`);
  }
  return flightEvents(response.body);
}

/** Only the current scan; the fallback when the page carries no history. */
async function currentScan(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/api/tracks`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ trackingNumbers: [code], visitorId: randomUUID() }),
  });
  if (response.status !== 200) {
    throw new TransientError(`SpeedX answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("SpeedX did not answer with JSON.");
  }
  if (!Array.isArray(payload)) {
    throw new UnexpectedResponseError("SpeedX answered without a list.");
  }
  const first: unknown = payload[0];
  return payload.length === 1 && typeof first === "object" && first !== null
    ? (first as Json)
    : null;
}

async function lookUp(http: PluginHttp, code: string): Promise<Json[] | null> {
  const events = await pageEvents(http, code);
  if (events !== null && events !== undefined && events.length > 0) {
    return events;
  }
  const current = await currentScan(http, code);
  if (current !== null) {
    return [current];
  }
  if (events === undefined) {
    throw new UnexpectedResponseError("SpeedX page no longer carries its tracking data.");
  }
  return null;
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!CODE_PATTERN.test(barcode)) {
      continue;
    }
    const events = await lookUp(context.http, barcode);
    if (events !== null) {
      snapshots.push(eventsSnapshot(events, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const speedx = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "SpeedX",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 8_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
