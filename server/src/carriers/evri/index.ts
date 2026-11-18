import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  asObject,
  objects,
  text,
  type Json,
  isoTime,
  newestFirst,
  rulesStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
} from "../../plugin/api.js";
import { EvriTracking, HOST } from "./api.js";

const CARRIER_ID = "evri";

const configSchema = z.object({
  /** Evri shows a parcel only together with the recipient's postcode. */
  postalCode: z
    .string()
    .transform((value) => value.trim().toUpperCase().replace(/\s+/g, " "))
    .pipe(z.string().regex(/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/)),
});
type Config = z.infer<typeof configSchema>;

const PLAUSIBLE = carrierPattern("evri");

/**
 * A tracking stage code (the suffix tells courier, shop and locker apart) from the shared table,
 * which also knows that on a return parcel the in-network stages are the way back.
 */
function stageStatus(code: string | null, returning: boolean): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const leg = returning ? "return" : "forward";
  return rulesStatus(CARRIER_ID, { code, fields: { stage: code, leg } })?.status ?? null;
}

const stageOf = (event: Json): string | null =>
  text(asObject(event["trackingStage"])["trackingStageCode"]);

function history(events: readonly Json[], returning: boolean): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["dateTime"], { naive: "reject", epoch: "auto", epochStrings: true });
    const stage = stageOf(event);
    const rawStatus = text(asObject(event["trackingStage"])["description"]) ?? stage;
    if (at !== null && rawStatus !== null) {
      result.push({ at, rawStatus, status: stageStatus(stage, returning), location: null });
    }
  }
  return newestFirst(result);
}

/** Only the parts of the answer that say nothing about the recipient are kept. */
function safeRaw(raw: Json, events: readonly Json[]): Json {
  const keep = [
    "discriminator",
    "creationDate",
    "serviceType",
    "returnParcel",
    "parcelShopDelivery",
  ];
  return {
    ...Object.fromEntries(keep.filter((key) => key in raw).map((key) => [key, raw[key]])),
    trackingEvents: events.map((event) => ({
      dateTime: event["dateTime"],
      trackingStageCode: stageOf(event),
      trackingPointCode: text(asObject(event["trackingPoint"])["trackingPointCode"]),
    })),
  };
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const events = objects(raw["trackingEvents"]);
  const returning = raw["returnParcel"] === true;
  const entries = history(events, returning);
  const byTime = newestFirst(
    events.flatMap((event) => {
      const at = isoTime(event["dateTime"], { naive: "reject", epoch: "auto", epochStrings: true });
      return at === null ? [] : [{ at, stage: stageOf(event) }];
    }),
  );
  const stage = byTime[0]?.stage ?? null;
  const status = stageStatus(stage, returning);
  if (stage !== null && status === null) {
    report(stage);
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: entries[0]?.rawStatus ?? stage,
    deliveredAt: delivered
      ? (byTime.find((entry) => stageStatus(entry.stage, returning) === "delivered")?.at ?? null)
      : null,
    // Shop and locker stages carry `pickup` in the shared table.
    pickup:
      raw["parcelShopDelivery"] === true ||
      (stage !== null && rulesStatus(CARRIER_ID, { code: stage })?.pickup === true),
    url: `https://www.evri.com/track/parcel/${encodeURIComponent(barcode)}/details`,
    sender: text(asObject(raw["sender"])["displayName"]),
    history: entries,
    raw: safeRaw(raw, events),
  });
}

async function track(context: PluginContext<Config, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status");
  const client = new EvriTracking(context.http, context.logger, context.session);
  try {
    return await trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
      const raw = await client.parcel(code, context.config.postalCode);
      return raw === null ? null : toSnapshot(raw, tracked, report);
    });
  } finally {
    await client.save();
  }
}

/** Evri (United Kingdom): the public tracking website's API, by barcode and postcode. */
export const evri = defineCarrier<Config, unknown>({
  id: CARRIER_ID,
  name: "Evri",
  countries: ["GB"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
