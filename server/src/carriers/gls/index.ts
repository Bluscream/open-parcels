import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { groupSnapshot, lookUpGroup } from "./group.js";
import { lookUpNl, nlSnapshot } from "./nl.js";
import { CARRIER_ID, COUNTRIES, GROUP_COUNTRIES, NL_HOST } from "./shared.js";

/** GLS parcel numbers: digits, or short letter-and-digit references. Anything else is never sent. */
const BARCODE_PATTERN = carrierPattern("gls");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Every GLS lookup is keyed on the delivery country and, for history, the delivery postcode, so
 * a tracking source covers parcels delivered to one address.
 */
const configSchema = z.looseObject({
  country: z.enum(COUNTRIES),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 -]{3,10}$/),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const { country, postalCode } = context.config;
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const group = GROUP_COUNTRIES[country];
  const snapshots: ParcelSnapshot[] = [];
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    if (group === undefined) {
      const raw = await lookUpNl(context.http, barcode, postalCode);
      if (raw !== null) {
        snapshots.push(nlSnapshot(raw, barcode, postalCode, report));
      }
      continue;
    }
    const millis = context.clock.now().getTime();
    const raw = await lookUpGroup(context.http, millis, group, barcode, postalCode);
    if (raw !== null) {
      snapshots.push(groupSnapshot(raw, barcode, group, report));
    }
  }
  return { snapshots, complete: true };
}

export const gls = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "GLS",
  countries: [...COUNTRIES],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [NL_HOST]: { intervalMs: 5_000, burst: 2 },
      "gls-group.com": { intervalMs: 5_000, burst: 2 },
      "gls-group.eu": { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
