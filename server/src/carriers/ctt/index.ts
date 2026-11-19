import { z } from "zod";
import {
  carrierPattern,
  asArray,
  asObject,
  carrierKey,
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";
import { EXPRESS_HOST, expressSnapshot, isExpressCode, lookUpExpress } from "./express.js";
import { lookUpPortal, PORTAL_HOST } from "./portal.js";

const CARRIER_ID = "ctt";
const PLAUSIBLE = carrierPattern("ctt");

/** A portal `StateId` (the stable integer, never the display literal) from the shared table. */
const stateStatus = (id: string | null, report?: () => void): ParcelStatus | null =>
  id === null ? null : ruleStatus(CARRIER_ID, `state:${id}`, report);

/** The platform writes "no date" as 1 January 1900. */
function cttTime(value: unknown): string | null {
  const raw = text(value);
  return raw === null || raw.startsWith("1900-01-01")
    ? null
    : isoTime(raw, { naive: "utc", keepFraction: true });
}

/**
 * The newest event decides, never the highest stage: a parcel can go out, fail and return to
 * transit. Events arrive newest first and duplicates are real, so they are kept.
 */
function portalSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  const events = asArray(asObject(raw["Events"])["List"]).filter(isObject);
  const newest = events[0];
  const newestId = newest === undefined ? null : text(newest["StateId"]);
  const status = stateStatus(newestId, () => {
    report(newestId ?? "");
  });
  const firstWith = (id: string) => events.find((event) => text(event["StateId"]) === id);
  const history: SnapshotEvent[] = events.flatMap((event) => {
    const at = cttTime(event["DateTime"]);
    const rawStatus = text(event["Event"]) ?? text(event["State"]);
    return at === null || rawStatus === null
      ? []
      : [
          {
            at,
            rawStatus,
            status: stateStatus(text(event["StateId"])),
            location: text(event["Local"]),
          },
        ];
  });
  const barcode = text(raw["ObjectCode"]) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: newest === undefined ? null : text(newest["State"]),
    delivered: status === "delivered",
    deliveredAt: status === "delivered" ? cttTime(firstWith("12")?.["DateTime"]) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? text(firstWith("14")?.["Local"]) : null,
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    sender: text(raw["Sender"]),
    receiver: text(raw["Recipient"]),
    history: newestFirst(history),
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, PLAUSIBLE, async (barcode) => {
    const code = barcode.toUpperCase();
    if (isExpressCode(code)) {
      const raw = await lookUpExpress(context.http, code);
      return raw === null
        ? null
        : expressSnapshot(raw, barcode, (c) => {
            report(`express:${c}`);
          });
    }
    const raw = await lookUpPortal(context.http, code);
    return raw === null ? null : portalSnapshot(raw, barcode, report);
  });
}

export const ctt = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "CTT",
  countries: ["PT", "ES"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [PORTAL_HOST]: { intervalMs: 5_000, burst: 3 },
      [EXPRESS_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: {
      value: carrierKey(CARRIER_ID, "browser_user_agent"),
      reason:
        "The CTT tracking hosts sit behind a firewall that rejects non-browser clients (error 1010).",
    },
  },
  track,
});
