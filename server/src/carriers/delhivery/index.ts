import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  asObject,
  expectStatus,
  isObject,
  ruleStatus,
  isoTime as kitIsoTime,
  newestFirst,
  objects,
  readObject,
  text,
  trackEach,
  unknownReporter,
  type Json,
  type ParcelStatus as Status,
  type PluginHttp,
} from "../../plugin/api.js";

const CARRIER_ID = "delhivery";
const HOST = "dlv-api.delhivery.com";
const ZONE = "Asia/Kolkata";

/** Epoch values (numbers or digit strings), offset times, and offset-less times in India. */
const isoTime = (value: unknown, zone: string): string | null =>
  kitIsoTime(value, { naive: { zone }, epoch: "auto", epochStrings: true });
/** The endpoint answers 401 to every request without the website's own origin. */
const SITE_HEADERS = {
  accept: "application/json",
  origin: "https://www.delhivery.com",
  referer: "https://www.delhivery.com/",
};

/** Delhivery waybills are digits; anything else is never sent. */
const PLAUSIBLE = carrierPattern("delhivery");

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/v3/unified-tracking-new`);
  url.searchParams.set("wbn", code);
  const response = await http.request(url, { headers: SITE_HEADERS });
  expectStatus(response, "Delhivery tracking");
  // The envelope claims success even for unknown waybills; only a filled `data` list is a hit.
  const data = readObject(response, "Delhivery tracking")["data"];
  if (data === undefined || data === null || (Array.isArray(data) && data.length === 0)) {
    return null;
  }
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  if (!isObject(first)) {
    throw new UnexpectedResponseError("Delhivery tracking listed something that is not a parcel.");
  }
  return first;
}

/** The label of the step the parcel is on: the marked index, a step flag, else the last one. */
function ladderLabel(raw: Json): string | null {
  const steps = objects(raw["trackingStates"]);
  const index = raw["currentTrackIndex"];
  if (typeof index === "number" && Number.isInteger(index)) {
    const marked = text(steps[index]?.["label"]);
    if (marked !== null) {
      return marked;
    }
  }
  const flagged = (flag: string): string | null =>
    text(steps.findLast((step) => step["stepStatus"] === flag)?.["label"]);
  return (
    flagged("current") ??
    flagged("finished") ??
    text(steps.findLast((step) => text(step["label"]) !== null)?.["label"])
  );
}

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const step of objects(raw["trackingStates"])) {
    const label = text(step["label"]);
    for (const scan of objects(step["scans"])) {
      const at = isoTime(scan["scanDateTime"], ZONE);
      const rawStatus = text(scan["scanNslRemark"]) ?? label;
      if (at !== null && rawStatus !== null) {
        events.push({
          at,
          rawStatus,
          status: ruleStatus(CARRIER_ID, label),
          location: text(scan["cityLocation"]) ?? text(scan["scannedLocation"]),
        });
      }
    }
  }
  return newestFirst(events);
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const rawStatus = text(raw["hqStatus"]) ?? ladderLabel(raw);
  // `hqStatus` first; the `trackingStates` ladder labels fill in when it is missing.
  const status: Status | null = ruleStatus(CARRIER_ID, rawStatus);
  if (rawStatus !== null && status === null) {
    report(rawStatus);
  }
  const events = history(raw);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus,
    deliveredAt: delivered
      ? (isoTime(asObject(raw["status"])["statusDateTime"], ZONE) ?? events[0]?.at ?? null)
      : null,
    plannedFrom: delivered ? null : isoTime(raw["PromiseDeliveryDate"], ZONE),
    url: `https://www.delhivery.com/track-v2/package/${encodeURIComponent(barcode)}`,
    sender: text(raw["clientName"]),
    receiver: text(raw["consignee"]),
    history: events,
    raw,
  });
}

async function track(context: PluginContext<unknown, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** Delhivery (India): the public waybill tracking used by its website. */
export const delhivery = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "Delhivery",
  countries: ["IN"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
