import { z } from "zod";
import {
  carrierKey,
  defineCarrier,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { trackingSnapshot, type Reporter } from "./snapshot.js";
import { isPlausibleBarcode, isPlausiblePostcode, TrackingRun } from "./tracking.js";

/**
 * A tracking source is one recipient postcode: the lookup needs it next to every code. The
 * account (mobile app) is not offered: its requests are signed with a key taken from the app.
 */
const configSchema = z.looseObject({
  postcode: z.string().trim().min(3).max(10),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const wanted = barcodes.filter(isPlausibleBarcode);
  const postcode = context.config.postcode;
  if (wanted.length === 0 || !isPlausiblePostcode(postcode)) {
    return { snapshots: [], complete: true };
  }
  const report: Reporter = {
    step: (key) => {
      context.reportUnknown("step", key);
    },
    deliveryMode: (mode) => {
      context.reportUnknown("delivery_mode", mode);
    },
  };
  const run = await TrackingRun.open(context.http);
  const snapshots: ParcelSnapshot[] = [];
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of wanted) {
    const expedition = await run.lookUp(barcode, postcode);
    if (expedition !== null) {
      snapshots.push(trackingSnapshot(expedition, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const mondialRelay = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Mondial Relay",
  countries: ["FR", "BE", "NL", "ES", "PT", "LU"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: {
      value: carrierKey(CARRIER_ID, "browser_user_agent"),
      reason: "The public tracking page refuses requests that do not look like a browser.",
    },
  },
  track,
});
