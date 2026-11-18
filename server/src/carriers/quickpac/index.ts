import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { newestFirst, objects, readObject, text, zonedIso, type Json } from "../../plugin/parse.js";

export const CARRIER_ID = "quickpac";
const ZONE = "Europe/Zurich";
const HOST = "parcelsearch.quickpac.ch";
const BASE = `https://${HOST}/api/ParcelSearch`;
const BARCODE = /^[A-Z0-9]{8,40}$/i;

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/**
 * Quickpac's numeric codes, grouped the way its own tracking page picks an icon. Codes outside
 * these groups (3xxx and 4xxx included) are the page's "info" catch-all and stay unmapped. The
 * shared rules have no table for Quickpac yet; this belongs there.
 */
export function codeStatus(code: number | null): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const exact: Readonly<Record<number, ParcelStatus>> = {
    1000: "registered",
    2600: "at_pickup_point",
    2301: "in_transit",
    2601: "in_transit",
    2604: "in_transit",
  };
  const groups: Readonly<Record<number, ParcelStatus>> = {
    21: "delivered",
    24: "returning",
    22: "in_transit",
    25: "in_transit",
    12: "in_transit",
    14: "in_transit",
    15: "in_transit",
    18: "out_for_delivery",
    19: "out_for_delivery",
  };
  return exact[code] ?? groups[Math.floor(code / 100)] ?? null;
}

const configSchema = z.object({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

/**
 * Quickpac answers a bare 400 for every unknown code, the same as for a wrong route. The
 * code-free start-up call tells the two apart: when it works, the code really is unknown.
 */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`${BASE}/GetPublicTracking/${encodeURIComponent(barcode)}/de/false`);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 400) {
    const canary = await http.request(new URL(`${BASE}/GetTrackingStartup/de`));
    if (canary.status === 200) {
      return null;
    }
    throw new UnexpectedResponseError(
      "Quickpac's tracking route answers 400 and its start-up call fails.",
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`Quickpac answered HTTP ${response.status}.`);
  }
  return readObject(response, "Quickpac");
}

const code = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const history: SnapshotEvent[] = [];
  for (const entry of objects(raw["Protocol"])) {
    const at = zonedIso(entry["Time"], ZONE);
    const entryCode = code(entry["Status"]);
    const rawStatus = text(entry["StatusText"]) ?? (entryCode === null ? null : String(entryCode));
    if (at !== null && rawStatus !== null) {
      history.push({ at, status: codeStatus(entryCode), rawStatus, location: null });
    }
  }
  newestFirst(history);
  const lastCode = code(raw["LastStatusCode"]);
  const status = codeStatus(lastCode);
  if (lastCode !== null && status === null) {
    report(String(lastCode));
  }
  const delivered = status === "delivered";
  const identCode = text(raw["IdentCode"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: identCode,
    status,
    rawStatus: text(raw["LastStatus"]) ?? (lastCode === null ? null : String(lastCode)),
    delivered,
    deliveredAt: delivered
      ? (history.find((entry) => entry.status === "delivered")?.at ?? null)
      : null,
    // Code 2600 carries the state; the address itself sits behind a personal token.
    pickup: status === "at_pickup_point",
    url: `https://quickpac.ch/de/tracking?identcode=${encodeURIComponent(identCode)}`,
    history,
    raw,
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (value: string): void => {
    context.reportUnknown("status_code", value);
  };
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

/** Quickpac (Switzerland): the public parcel search. */
export const quickpac = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Quickpac",
  countries: ["CH"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 4_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
