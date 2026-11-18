import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausibleBarcode, lookUp, trackingSnapshot } from "./tracking.js";

const configSchema = z.looseObject({
  /** Language of event texts and place names; the carrier knows only German and English. */
  language: z.enum(["de", "en"]).optional(),
});
type Config = z.infer<typeof configSchema>;

/** The public tracking is keyed on the code alone; there is no account. */
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (key: string): void => {
    context.reportUnknown("status_code", key);
  };
  const language = context.config.language ?? "de";
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode, language);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const oesterreichischePost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Österreichische Post",
  countries: ["AT"],
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
