import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausible, lookUp, trackingSnapshot } from "./tracking.js";

/** Paack only answers for a code together with its delivery postcode. */
const configSchema = z.looseObject({
  /** Postcode used for every code that has no entry in `postalCodes`. */
  postalCode: z.string().trim().min(1).optional(),
  /** Postcode per tracking code. */
  postalCodes: z.record(z.string(), z.string().trim().min(1)).optional(),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    const postalCode = context.config.postalCodes?.[barcode] ?? context.config.postalCode;
    if (postalCode === undefined || !isPlausible(barcode, postalCode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode, postalCode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, postalCode, report));
    }
  }
  return { snapshots, complete: true };
}

export const paack = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Paack",
  countries: ["ES", "PT", "FR", "IT"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 6_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
