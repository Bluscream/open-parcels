import { z } from "zod";
import {
  carrierPattern,
  asArray,
  asObject,
  defineCarrier,
  isObject,
  parseLocal,
  readJson,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "cdl";
const HOST = "apps.cdldelivers.com";
/** Scan times carry no offset; Eastern time is the service's home zone, not proven by the payload. */
const ZONE = "America/New_York";
/** The lookup also matches shippers' own references; only these shapes are ever sent. */
const PLAUSIBLE = carrierPattern("cdl");
/** Responses inline proof-of-delivery photos, so allow a bit more than usual. */
const MAX_BYTES = 4 * 1024 * 1024;

/** The scan wording that completes a delivery; it decides the order within a minute. */
const COMPLETION = "delivery complete";

/** Upper-cases and gives a ten-digit order number its hyphen back. */
export function normalizeCode(value: string): string {
  const code = value.trim().toUpperCase();
  const order = /^(\d{9})(\d)$/.exec(code);
  return order === null ? code : `${order[1]}-${order[2]}`;
}

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/Tracking-Page-API/Tracking/details`);
  url.searchParams.set("value", code);
  const response = await http.request(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    maxBytes: MAX_BYTES,
  });
  if (response.status === 204) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`CDL tracking answered HTTP ${response.status}.`);
  }
  const body = readJson(response, "CDL tracking");
  if (
    !isObject(body) ||
    !Array.isArray(body["trackingEvents"]) ||
    !isObject(body["trackingInformation"])
  ) {
    throw new UnexpectedResponseError("CDL tracking answered in an unexpected shape.");
  }
  // A response for another reference is ignored rather than shown as this parcel.
  const reference = text(asObject(body["trackingInformation"])["referenceNumber"])?.toUpperCase();
  return reference === code ? body : null;
}

interface Scan {
  readonly at: string;
  readonly wording: string;
}

/** Oldest to newest, duplicates (one per delivery photo) collapsed; a completion sorts last within its minute. */
function scans(raw: Json): Scan[] {
  const seen = new Set<string>();
  const result: Scan[] = [];
  for (const entry of asArray(raw["trackingEvents"])) {
    const event = asObject(entry);
    const wording = text(event["trackingEvent"]);
    const at = parseLocal(event["trackingEventTimestamp"], ZONE);
    const key = `${wording ?? ""}|${at ?? ""}`;
    if (wording !== null && at !== null && !seen.has(key)) {
      seen.add(key);
      result.push({ at, wording });
    }
  }
  const minute = (scan: Scan) => Math.floor(Date.parse(scan.at) / 60_000);
  const done = (scan: Scan) => (scan.wording.toLowerCase() === COMPLETION ? 1 : 0);
  return result.sort(
    (a, b) => minute(a) - minute(b) || done(a) - done(b) || Date.parse(a.at) - Date.parse(b.at),
  );
}

function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  const ordered = scans(raw);
  // The service sends English scan wording and no code; the shared table reads it case-folded.
  const map = (wording: string, rep?: (c: string) => void) =>
    ruleStatus(CARRIER_ID, wording.toLowerCase(), rep);
  const completion = ordered.findLast((scan) => scan.wording.toLowerCase() === COMPLETION);
  const newest = ordered.at(-1);
  if (newest !== undefined && completion === undefined) {
    map(newest.wording, report);
  }
  // Any completion means delivered; otherwise the newest scan that maps decides.
  const status =
    completion === undefined
      ? (ordered.map((scan) => map(scan.wording)).findLast((mapped) => mapped !== null) ?? null)
      : "delivered";
  const history: SnapshotEvent[] = ordered
    .map((scan) => ({
      at: scan.at,
      rawStatus: scan.wording,
      status: map(scan.wording),
      location: null,
    }))
    .reverse();
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: completion?.wording ?? newest?.wording ?? null,
    delivered: completion !== undefined,
    deliveredAt: completion?.at ?? null,
    url: `https://${HOST}/Tracking-Page/track?id=${encodeURIComponent(code)}`,
    history,
    // Only the scans: the full answer carries delivery photos and addresses.
    raw: { trackingEvents: ordered },
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  const options = { plausible: PLAUSIBLE, normalize: normalizeCode, dedupe: false };
  return trackEach(barcodes, options, async (code, barcode) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, barcode, report);
  });
}

export const cdl = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "CDL Last Mile",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
