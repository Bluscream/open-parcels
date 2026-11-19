import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  isoTime,
  newestFirst,
  objects,
  readObject,
  ruleFieldsStatus,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "quickpac";
const ZONE = "Europe/Zurich";
const HOST = "parcelsearch.quickpac.ch";
const BASE = `https://${HOST}/api/ParcelSearch`;
const BARCODE = carrierPattern("quickpac");

/**
 * Quickpac's numeric codes, grouped the way its own tracking page picks an icon. Codes outside
 * these groups (3xxx and 4xxx included) are the page's "info" catch-all and stay unmapped.
 */
export function codeStatus(code: number | null): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  // A few exact codes first, then the code's hundreds group (both in the shared table).
  const fields = { code: String(code), group: String(Math.floor(code / 100)) };
  return ruleFieldsStatus(CARRIER_ID, fields);
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

const STRINGS = { numbers: false } as const;

const code = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const events: SnapshotEvent[] = [];
  for (const entry of objects(raw["Protocol"])) {
    const at = isoTime(entry["Time"], { naive: { zone: ZONE } });
    const entryCode = code(entry["Status"]);
    const rawStatus =
      text(entry["StatusText"], STRINGS) ?? (entryCode === null ? null : String(entryCode));
    if (at !== null && rawStatus !== null) {
      events.push({ at, status: codeStatus(entryCode), rawStatus, location: null });
    }
  }
  const history = newestFirst(events);
  const lastCode = code(raw["LastStatusCode"]);
  const status = codeStatus(lastCode);
  if (lastCode !== null && status === null) {
    report(String(lastCode));
  }
  const delivered = status === "delivered";
  const identCode = text(raw["IdentCode"], STRINGS) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: identCode,
    status,
    rawStatus: text(raw["LastStatus"], STRINGS) ?? (lastCode === null ? null : String(lastCode)),
    delivered,
    deliveredAt: delivered
      ? (history.find((entry) => entry.status === "delivered")?.at ?? null)
      : null,
    // Code 2600 carries the state; the address itself sits behind a personal token.
    pickup: status === "at_pickup_point",
    url: rulesTrackingUrl(CARRIER_ID, identCode),
    history,
    raw,
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = (value: string): void => {
    context.reportUnknown("status_code", value);
  };
  return trackEach(barcodes, BARCODE, async (barcode) => {
    const raw = await lookUp(context.http, barcode);
    return raw === null ? null : toSnapshot(raw, barcode, report);
  });
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
