import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  isObject,
  isoTime as kitIsoTime,
  newestFirst,
  requestJson,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  UnexpectedResponseError,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
/** Offset-less times are UTC; numbers are epoch milliseconds. */
const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "utc", epoch: "ms", keepFraction: true });

const CARRIER_ID = "colisweb";
const HOST = "www.colisweb.com";
const PLAUSIBLE = carrierPattern("colisweb");

/**
 * The reply has no event list, only these milestone timestamps, oldest stage first. The stage
 * each marks is the shared table's "milestone:<field>".
 */
const MILESTONES: readonly (readonly [string, ParcelStatus | null])[] = [
  "deliveryConfirmationDate",
  "pickedUpDate",
  "deliveredDate",
].map((field) => [field, ruleStatus(CARRIER_ID, `milestone:${field}`)] as const);

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
  // `step` values are looked up lower-cased with `_` and `-` removed.
  const key = step?.toLowerCase().replace(/[-_]/g, "") ?? null;
  // A step that does not map falls back to the newest milestone that is set.
  const status =
    ruleStatus(CARRIER_ID, key, () => {
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
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, PLAUSIBLE, async (code) => {
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
