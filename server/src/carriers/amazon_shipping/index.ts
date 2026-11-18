import { z } from "zod";
import {
  asArray,
  asObject,
  defineCarrier,
  snapshot,
  text,
  trackEach,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { HISTORY_EXPIRED, lookUp, publicUrl, regionFor } from "./lookup.js";
import { AMAZON_ID, classify, key, metaValue, orderedEvents, resolveStatus } from "./status.js";
import { parseMoment } from "./time.js";

/**
 * Amazon Shipping's by-number tracker. A separate plug-in from the Amazon shop: it needs no
 * account, no storefront and no browser User-Agent. Its parcels are filed under the `amazon`
 * carrier, so a shop order and its tracked parcel become one.
 */
const PLUGIN_ID = "amazon_shipping";
const PLAUSIBLE = /^[A-Z0-9]{8,40}$/i;

function sender(raw: Json, summary: Json): string | null {
  // The brand the parcel was ordered from, not the fulfilment house shipping on its behalf.
  return (
    text(asObject(raw["shipperDetails"])["shipperName"]) ??
    text(metaValue(asObject(summary["metadata"]), "shipperName"))
  );
}

export function amazonShippingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const { zone } = regionFor(barcode);
  const parse = (value: unknown) => parseMoment(value, zone);
  const tracker = asObject(raw["progressTracker"]);
  const summary = asObject(tracker["summary"]);
  const events = orderedEvents(asObject(raw["eventHistory"])["eventHistory"], parse);
  const expired = asArray(tracker["errors"]).some(
    (error) => asObject(error)["errorCode"] === HISTORY_EXPIRED,
  );
  // An expired parcel's summary is a placeholder; nothing about it can be trusted.
  const { status, rawStatus } = expired
    ? { status: null, rawStatus: HISTORY_EXPIRED }
    : resolveStatus(summary, events, report);
  const delivered = status === "delivered";
  const deliveredEvent = [...events]
    .reverse()
    .find((event) => key(event.code ?? "") === "DELIVERED");
  const metadata = asObject(summary["metadata"]);
  const expected = parse(
    tracker["expectedDeliveryDate"] ?? metaValue(metadata, "expectedDeliveryDate"),
  );
  const history: SnapshotEvent[] = events.flatMap((event) =>
    event.moment.iso === null || event.code === null
      ? []
      : [
          {
            at: event.moment.iso,
            rawStatus: event.code,
            status: classify(event.code, () => undefined),
            location: null,
          },
        ],
  );
  return snapshot({
    carrier: AMAZON_ID,
    barcode,
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered
      ? (deliveredEvent?.moment.iso ?? parse(metaValue(metadata, "deliveryDate"))?.iso ?? null)
      : null,
    plannedFrom: delivered || expired ? null : (expected?.iso ?? null),
    pickup: status === "at_pickup_point",
    url: publicUrl(barcode),
    sender: sender(raw, summary),
    history: history.reverse(),
    raw,
  });
}

const configSchema = z.looseObject({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

const TRACKER_LIMIT = { intervalMs: 6_000, burst: 2 } as const;

export const amazonShipping = defineCarrier<Config, null>({
  id: PLUGIN_ID,
  name: "Amazon Shipping",
  countries: ["GB", "FR", "IT", "ES", "US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      "track.amazon.com": TRACKER_LIMIT,
      "track.amazon.co.uk": TRACKER_LIMIT,
      "track.amazon.fr": TRACKER_LIMIT,
      "track.amazon.it": TRACKER_LIMIT,
      "track.amazon.es": TRACKER_LIMIT,
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, barcode, (kind, value) => {
        context.reportUnknown(kind, value);
      });
      return raw === null
        ? null
        : amazonShippingSnapshot(raw, barcode, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
