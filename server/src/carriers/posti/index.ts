import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type PluginContext } from "../../plugin/api.js";
import {
  AUTH_HOST,
  CARRIER_ID,
  GRAPHQL_HOST,
  PostiTracking,
  trackingSnapshot,
} from "./tracking.js";

const BARCODE = /^[A-Z0-9]{8,40}$/i;

const configSchema = z.object({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const client = new PostiTracking(context.http);
  const snapshots: ParcelSnapshot[] = [];
  const report = (kind: string, key: string): void => {
    context.reportUnknown(kind, key);
  };
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const raw = await client.lookUp(barcode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

/** Posti (Finland): the public tracking, on a throwaway anonymous token. */
export const posti = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Posti",
  countries: ["FI"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [GRAPHQL_HOST]: { intervalMs: 4_000, burst: 2 },
      [AUTH_HOST]: { intervalMs: 30_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
