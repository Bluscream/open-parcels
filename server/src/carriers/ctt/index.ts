import { z } from "zod";
import {
  asArray,
  asObject,
  defineCarrier,
  isObject,
  isoTime,
  lookUpStatus,
  newestFirst,
  snapshot,
  text,
  trackEach,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { EXPRESS_HOST, expressSnapshot, isExpressCode, lookUpExpress } from "./express.js";
import { lookUpPortal, PORTAL_HOST } from "./portal.js";

const CARRIER_ID = "ctt";
const PLAUSIBLE = /^[A-Z0-9]{8,30}$/i;

/**
 * CTT `StateId`s, keyed on the stable integer, never on the display literal. Six more states
 * exist in the app's own code, but their ids were never seen and are not guessed.
 */
const STATE_STATUS: Readonly<Record<string, ParcelStatus>> = {
  "1": "registered",
  "2": "in_transit",
  "5": "returning",
  "7": "out_for_delivery",
  "8": "in_transit",
  "10": "in_transit",
  "11": "in_transit",
  "12": "delivered",
  "13": "problem",
  "14": "at_pickup_point",
};

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
  const status = lookUpStatus(
    STATE_STATUS,
    newest === undefined ? null : text(newest["StateId"]),
    report,
  );
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
            status: lookUpStatus(STATE_STATUS, text(event["StateId"])),
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
    url: `https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=${encodeURIComponent(barcode)}`,
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
      value:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      reason:
        "The CTT tracking hosts sit behind a firewall that rejects non-browser clients (error 1010).",
    },
  },
  track,
});
