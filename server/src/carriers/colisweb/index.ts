import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  isObject,
  isoTime,
  mapLocal,
  newestFirst,
  requestJson,
  statusReporter,
  text,
  trackOneByOne,
  type Json,
  type ParcelStatus,
} from "../_kit/json.js";

const CARRIER_ID = "colisweb";
const HOST = "www.colisweb.com";
const PLAUSIBLE = /^[A-Z0-9-]{6,40}$/i;

/** `step` values, lower-cased with `_` and `-` removed. */
const STEP_STATUS: Readonly<Record<string, ParcelStatus>> = {
  idle: "registered",
  confirmed: "registered",
  courseaccepted: "registered",
  pickedup: "in_transit",
  packagewithdrawn: "in_transit",
  packagewithdrawalpbok: "in_transit",
  outfordelivery: "out_for_delivery",
  deliveryinprogress: "out_for_delivery",
  delivered: "delivered",
  deliverypbok: "delivered",
  pickupfailed: "problem",
  packagewithdrawalfailed: "problem",
  deliveryfailed: "problem",
  nondeliverable: "problem",
  canceled: "problem",
  cancelled: "problem",
  deliverycanceled: "problem",
  deliverycancelled: "problem",
  packagereturned: "returning",
  deliveryreturned: "returning",
  packagereturnfailed: "returning",
  deliveryreturnfailed: "returning",
};

/** The reply has no event list, only these milestone timestamps, oldest stage first. */
const MILESTONES: readonly (readonly [string, ParcelStatus])[] = [
  ["deliveryConfirmationDate", "registered"],
  ["pickedUpDate", "in_transit"],
  ["deliveredDate", "delivered"],
];

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const body = await requestJson(http, new URL(`https://${HOST}/api/search`), "Colisweb tracking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: code }),
    notFound: [400, 404, 422],
  });
  if (body === null) {
    return null;
  }
  if (!isObject(body) || text(body["searchValue"]) !== code) {
    throw new UnexpectedResponseError("Colisweb answered for another number or in another shape.");
  }
  return body;
}

function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  const step = text(raw["step"]);
  const key = step?.toLowerCase().replace(/[-_]/g, "") ?? null;
  // A step that does not map falls back to the newest milestone that is set.
  const status =
    mapLocal(STEP_STATUS, key, () => {
      report(step ?? "");
    }) ??
    [...MILESTONES].reverse().find(([field]) => isoTime(raw[field]) !== null)?.[1] ??
    null;
  const delivered = status === "delivered";
  const rescheduling = raw["haveReschedule"] === true || raw["inRescheduleProcess"] === true;
  const from = delivered || rescheduling ? null : isoTime(raw["startsAt"]);
  const to = delivered || rescheduling ? null : isoTime(raw["endsAt"]);
  const history: SnapshotEvent[] = MILESTONES.flatMap(([field, stage]) => {
    const at = isoTime(raw[field]);
    return at === null ? [] : [{ at, status: stage, rawStatus: field, location: null }];
  });
  const withoutRecipient = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== "recipient"),
  );
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: step,
    delivered,
    deliveredAt: delivered ? isoTime(raw["deliveredDate"]) : null,
    plannedFrom: from,
    plannedTo: to === from ? null : to,
    url: `https://${HOST}/suivi-livraison?tracking=${encodeURIComponent(code)}`,
    sender: text(raw["clientName"]),
    history: newestFirst(history),
    raw: withoutRecipient,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = statusReporter(context);
  return trackOneByOne(barcodes, PLAUSIBLE, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, code, report);
  });
}

export const colisweb = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Colisweb",
  countries: ["FR"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
