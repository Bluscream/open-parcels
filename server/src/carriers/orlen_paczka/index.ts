import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausibleBarcode, lookUp, trackingSnapshot, untrackableSnapshot } from "./tracking.js";

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
    const result = await lookUp(context.http, barcode);
    if (result === null) {
      continue;
    }
    if ("untrackable" in result) {
      context.reportUnknown("error_code", result.untrackable);
      snapshots.push(untrackableSnapshot(barcode, result.untrackable));
    } else {
      snapshots.push(trackingSnapshot(result.raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const orlenPaczka = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "ORLEN Paczka",
  countries: ["PL"],
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
