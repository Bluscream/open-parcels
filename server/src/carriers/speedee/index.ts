import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { CARRIER_ID, pageSnapshot } from "./parse.js";

const HOST = "packages.speedeedelivery.com";
const CODE_PATTERN = /^[A-Z0-9]{8,30}$/i;
const MAX_PAGE_BYTES = 2_000_000;

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
    const url = new URL(`https://${HOST}/package_progress.php`);
    url.searchParams.set("barcode", barcode);
    // A redirect means the page moved or blocked us; never follow it.
    const response = await context.http.request(url, {
      redirect: "manual",
      maxBytes: MAX_PAGE_BYTES,
      headers: { accept: "text/html" },
    });
    if (response.status === 404) {
      continue;
    }
    if (response.status !== 200) {
      throw new TransientError(`Spee-Dee answered HTTP ${response.status}.`);
    }
    snapshots.push(pageSnapshot(response.body, barcode, report));
  }
  return { snapshots, complete: true };
}

export const speeDee = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Spee-Dee Delivery",
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
