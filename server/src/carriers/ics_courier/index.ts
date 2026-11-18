import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import {
  CARRIER_ID,
  isPlausibleBarcode,
  lookUp,
  TRACKING_HOST,
  trackingSnapshot,
} from "./tracking.js";

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
/** The public trace operation needs no sign-in. */
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (kind: string, key: string): void => {
    context.reportUnknown(kind, key);
  };
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    const records = await lookUp(context.http, barcode);
    if (records !== null) {
      snapshots.push(trackingSnapshot(barcode, records, report));
    }
  }
  return { snapshots, complete: true };
}

export const icsCourier = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "ICS Courier",
  countries: ["CA"],
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
