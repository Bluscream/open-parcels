import { z } from "zod";
import {
  asArray,
  asObject,
  defineCarrier,
  endOfLocalDay,
  isoTime,
  newestFirst,
  snapshot,
  text,
  trackEach,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { API_HOST, lookUp, SITE_HOST, TRACKING_PAGE } from "./lookup.js";

const CARRIER_ID = "acs_courier";
/** ACS works in Greece and Cyprus; its times carry no offset and are Athens time. */
const ZONE = "Europe/Athens";
const PLAUSIBLE = /^[A-Z0-9]{6,30}$/i;
const MIDNIGHT = /^\d{4}-\d{2}-\d{2}(?:[T ]00:00(?::00(?:\.0+)?)?)?$/;

/** Parcel-level `shipmentStatusId`. Other values fall back to the newest mappable event. */
const SHIPMENT_STATUS: Readonly<Record<number, ParcelStatus>> = { 4: "delivered", 7: "returning" };

/**
 * History `controlPid`; a child entry inherits its `controlParentPid`'s meaning. 400 is left
 * out on purpose: it covers both "with the courier" and "in a locker", told apart only by text.
 */
const EVENT_STATUS: Readonly<Record<number, ParcelStatus>> = {
  100: "in_transit",
  200: "in_transit",
  300: "in_transit",
  600: "delivered",
  620: "returning",
};
/** Known entries that say nothing about where the parcel is (306, and 404: a notification). */
const NEUTRAL_EVENTS = new Set([306, 404]);

interface Dated {
  readonly at: string;
  readonly event: Json;
}

function eventStatus(event: Json, report: (key: string) => void): ParcelStatus | null {
  const pid = event["controlPid"];
  if (typeof pid !== "number" || NEUTRAL_EVENTS.has(pid)) {
    return null;
  }
  const parent = event["controlParentPid"];
  const mapped =
    EVENT_STATUS[pid] ?? (typeof parent === "number" ? EVENT_STATUS[parent] : undefined);
  if (mapped === undefined) {
    report(`controlPid:${pid}`);
  }
  return mapped ?? null;
}

/** Dated entries, oldest first: the wire order follows the code, not the time. */
function datedEvents(raw: Json): Dated[] {
  const dated: Dated[] = [];
  for (const entry of asArray(raw["statusHistory"])) {
    const event = asObject(entry);
    const at = isoTime(event["controlPointDate"], ZONE);
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
  const fromId = typeof statusId === "number" ? SHIPMENT_STATUS[statusId] : undefined;
  const newestMapped = [...mapped].reverse().find((entry) => entry.status !== null);
  const status = fromId ?? newestMapped?.status ?? null;
  if (status === null && typeof statusId === "number") {
    report(`shipmentStatusId:${statusId}`);
  }
  const stamping =
    [...mapped].reverse().find((entry) => entry.status === status && status !== null) ??
    mapped.at(-1);
  const delivered = status === "delivered";
  const eta = delivered ? null : isoTime(raw["expectedDeliveryDate"], ZONE);
  const history: SnapshotEvent[] = mapped.flatMap(({ at, event, status: eventMapped }) => {
    const rawStatus = label(event);
    return rawStatus === null ? [] : [{ at, rawStatus, status: eventMapped, location: null }];
  });
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["trackingNumber"]) ?? barcode,
    status,
    rawStatus:
      (stamping === undefined ? null : label(stamping.event)) ??
      (typeof statusId === "number" ? String(statusId) : null),
    delivered,
    deliveredAt: delivered ? (isoTime(raw["deliveryDate"], ZONE) ?? stamping?.at ?? null) : null,
    // A bare date (midnight) means the whole local day; a real time stays a point estimate.
    plannedFrom: eta,
    plannedTo:
      eta !== null && MIDNIGHT.test(text(raw["expectedDeliveryDate"]) ?? "")
        ? endOfLocalDay(eta, ZONE)
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
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, context.session, barcode);
      return raw === null
        ? null
        : acsSnapshot(raw, barcode, (key) => {
            context.reportUnknown("status_code", key);
          });
    }),
});
