import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausibleBarcode, lookUp, trackingSnapshot } from "./tracking.js";

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;

/** The public tracking needs no sign-in. */
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const ontrac = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "OnTrac",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
