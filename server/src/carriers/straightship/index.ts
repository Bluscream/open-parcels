import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { CARRIER_ID, pageSnapshot } from "./parse.js";

const HOST = "straightship.com";
const CODE_PATTERN = /^[A-Z0-9]{6,30}$/i;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (text: string): void => {
    context.reportUnknown("status_text", text);
  };
  for (const barcode of barcodes) {
    if (!CODE_PATTERN.test(barcode)) {
      continue;
    }
    const code = encodeURIComponent(barcode.toUpperCase());
    const response = await context.http.request(
      new URL(`https://${HOST}/track-your-shipment/tracking-id/${code}/`),
      { headers: { accept: "text/html" }, maxBytes: 2_000_000 },
    );
    if (response.status !== 200) {
      throw new TransientError(`Straightship answered HTTP ${response.status}.`);
    }
    const parcel = pageSnapshot(response.body, barcode, report);
    if (parcel !== null) {
      snapshots.push(parcel);
    }
  }
  return { snapshots, complete: true };
}

export const straightship = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Straightship",
  countries: ["US"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 10_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
