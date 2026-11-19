import { z } from "zod";
import {
  carrierPattern,
  asArray,
  asObject,
  defineCarrier,
  localDay,
  isoTime,
  newestFirst,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import { API_HOST, lookUp, SITE_HOST, TRACKING_PAGE } from "./lookup.js";

const CARRIER_ID = "acs_courier";
/** ACS works in Greece and Cyprus; its times carry no offset and are Athens time. */
const ZONE = "Europe/Athens";
const PLAUSIBLE = carrierPattern("acs_courier");
const MIDNIGHT = /^\d{4}-\d{2}-\d{2}(?:[T ]00:00(?::00(?:\.0+)?)?)?$/;

interface Dated {
  readonly at: string;
  readonly event: Json;
}

/** A `controlPid` from the shared table; `unknown` there marks entries that say nothing. */
const pidStatus = (pid: number): ParcelStatus | null => ruleStatus(CARRIER_ID, `controlPid:${pid}`);

/** History `controlPid`; a child entry inherits its `controlParentPid`'s meaning. */
function eventStatus(event: Json, report: (key: string) => void): ParcelStatus | null {
  const pid = event["controlPid"];
  if (typeof pid !== "number") {
    return null;
  }
  const own = pidStatus(pid);
  if (own === "unknown") {
    return null;
  }
  const parent = event["controlParentPid"];
  const inherited = typeof parent === "number" ? pidStatus(parent) : null;
  const mapped = own ?? (inherited === "unknown" ? null : inherited);
  if (mapped === null) {
    report(`controlPid:${pid}`);
  }
  return mapped;
}

/** Dated entries, oldest first: the wire order follows the code, not the time. */
function datedEvents(raw: Json): Dated[] {
  const dated: Dated[] = [];
  for (const entry of asArray(raw["statusHistory"])) {
    const event = asObject(entry);
    const at = isoTime(event["controlPointDate"], { naive: { zone: ZONE } });
    if (at !== null) {
      dated.push({ at, event });
    }
  }
  return dated.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const label = (event: Json): string | null =>
  text(event["controlPoint"]) ?? text(event["description"]);

export function acsSnapshot(
  raw: Json,
  barcode: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const events = datedEvents(raw);
  const mapped = events.map(({ at, event }) => ({ at, event, status: eventStatus(event, report) }));
  const statusId = raw["shipmentStatusId"];
  const fromId =
    typeof statusId === "number" ? ruleStatus(CARRIER_ID, `shipmentStatusId:${statusId}`) : null;
  const newestMapped = [...mapped].reverse().find((entry) => entry.status !== null);
  const status = fromId ?? newestMapped?.status ?? null;
  if (status === null && typeof statusId === "number") {
    report(`shipmentStatusId:${statusId}`);
  }
  const stamping =
    [...mapped].reverse().find((entry) => entry.status === status && status !== null) ??
    mapped.at(-1);
  const delivered = status === "delivered";
  const eta = delivered ? null : isoTime(raw["expectedDeliveryDate"], { naive: { zone: ZONE } });
  const history: SnapshotEvent[] = mapped.flatMap(({ at, event, status: eventMapped }) => {
    const rawStatus = label(event);
    return rawStatus === null ? [] : [{ at, rawStatus, status: eventMapped, location: null }];
  });
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["trackingNumber"]), barcode),
    status,
    rawStatus:
      (stamping === undefined ? null : label(stamping.event)) ??
      (typeof statusId === "number" ? String(statusId) : null),
    delivered,
    deliveredAt: delivered
      ? (isoTime(raw["deliveryDate"], { naive: { zone: ZONE } }) ?? stamping?.at ?? null)
      : null,
    // A bare date (midnight) means the whole local day; a real time stays a point estimate.
    plannedFrom: eta,
    plannedTo:
      eta !== null && MIDNIGHT.test(text(raw["expectedDeliveryDate"]) ?? "")
        ? (localDay(eta, ZONE)?.to ?? null)
        : null,
    url: TRACKING_PAGE,
    sender: text(raw["sender"]),
    receiver: text(raw["recipientName"]) ?? text(raw["recipient"]),
    history: newestFirst(history),
    raw,
  });
}

const configSchema = z.looseObject({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

export const acsCourier = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "ACS Courier",
  countries: ["GR", "CY"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 5_000, burst: 2 },
      [SITE_HOST]: { intervalMs: 60_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track: (context: PluginContext<Config, null>, barcodes) => {
    // The lookup token is fetched from the page at most once per run, whatever the code count.
    const run = { fetched: false };
    return trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, context.session, barcode, run);
      return raw === null
        ? null
        : acsSnapshot(raw, barcode, (key) => {
            context.reportUnknown("status_code", key);
          });
    });
  },
});
