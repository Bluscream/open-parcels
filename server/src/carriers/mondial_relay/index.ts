import { z } from "zod";
import {
  carrierKey,
  defineCarrier,
  SignInRejectedError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import {
  ACCOUNT_HOST,
  accountSignIn,
  BFF_HOST,
  fetchAccountParcels,
  type AccountSecret,
} from "./account.js";
import { CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { trackingSnapshot, type Reporter } from "./snapshot.js";
import { isPlausibleBarcode, isPlausiblePostcode, TrackingRun } from "./tracking.js";

/**
 * A tracking source is one recipient postcode: the lookup needs it next to every code. An account
 * source signs in to the app's account in one market, which decides the sign-in page.
 */
const configSchema = z.looseObject({
  postcode: z.string().trim().min(3).max(10).optional(),
  market: z.enum(["FR", "BE", "NL", "ES", "PT"]).optional(),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z
  .object({ refreshToken: z.string().min(1), deviceId: z.string().min(1) })
  .nullable();
type Secret = AccountSecret | null;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const wanted = barcodes.filter(isPlausibleBarcode);
  const postcode = context.config.postcode;
  if (wanted.length === 0 || postcode === undefined || !isPlausiblePostcode(postcode)) {
    return { snapshots: [], complete: true };
  }
  const report: Reporter = {
    step: (key) => {
      context.reportUnknown("step", key);
    },
    deliveryMode: (mode) => {
      context.reportUnknown("delivery_mode", mode);
    },
  };
  const run = await TrackingRun.open(context.http);
  const snapshots: ParcelSnapshot[] = [];
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of wanted) {
    const expedition = await run.lookUp(barcode, postcode);
    if (expedition !== null) {
      snapshots.push(trackingSnapshot(expedition, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const mondialRelay = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Mondial Relay",
  countries: ["FR", "BE", "NL", "ES", "PT", "LU"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [accountSignIn<Config>(), { type: "none", kinds: ["tracking"] }],
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 5_000, burst: 2 },
      [ACCOUNT_HOST]: { intervalMs: 10_000, burst: 2 },
      [BFF_HOST]: { intervalMs: 4_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: {
      value: carrierKey(CARRIER_ID, "browser_user_agent"),
      reason: "The public tracking page refuses requests that do not look like a browser.",
    },
  },
  track,
  async fetchAccount(context) {
    if (context.secret === null) {
      throw new SignInRejectedError("Sign in to your Mondial Relay account first.");
    }
    return fetchAccountParcels(context, context.secret);
  },
});
