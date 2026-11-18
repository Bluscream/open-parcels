import { z } from "zod";
import { defineCarrier, trackEach, type PluginContext } from "../../plugin/api.js";
import {
  CARRIER_ID,
  BARCODE_PATTERN,
  lookUp,
  TRACKING_HOST,
  trackingSnapshot,
} from "./tracking.js";

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
/** The public tracking page needs no sign-in. */
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = (kind: string, key: string): void => {
    context.reportUnknown(kind, key);
  };
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  return trackEach(barcodes, BARCODE_PATTERN, async (barcode) => {
    const page = await lookUp(context.http, barcode);
    return page === null ? null : trackingSnapshot(page, report);
  });
}

export const hrvatskaPosta = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Hrvatska pošta",
  countries: ["HR"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 6_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
