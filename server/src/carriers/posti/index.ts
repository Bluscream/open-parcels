import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  SignInRejectedError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { fetchPostiAccount } from "./account.js";
import { deviceSchema } from "./device.js";
import { POSTI_APP } from "./keys.js";
import { bankSignIn } from "./login.js";
import {
  AUTH_HOST,
  CARRIER_ID,
  GRAPHQL_HOST,
  PostiTracking,
  trackingSnapshot,
} from "./tracking.js";

const BARCODE = carrierPattern("posti");

const configSchema = z.object({});
/** Tracking needs nothing; an OmaPosti account keeps its trusted device and the tokens it got. */
const secretSchema = z
  .object({
    device: deviceSchema,
    idToken: z.string().min(1),
    roleTokens: z.array(z.record(z.string(), z.unknown())),
  })
  .nullable();
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

/** Posti (Finland): public tracking on a throwaway anonymous token, and the OmaPosti account. */
export const posti = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Posti",
  countries: ["FI"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [bankSignIn<Config>(), { type: "none", kinds: ["tracking"] }],
  http: {
    limits: {
      [GRAPHQL_HOST]: { intervalMs: 4_000, burst: 2 },
      // A login makes four calls here within a minute; tracking mints one token per run.
      [AUTH_HOST]: { intervalMs: 15_000, burst: 4 },
      "mfa.posti.fi": { intervalMs: 5_000, burst: 3 },
      [POSTI_APP.uasHost]: { intervalMs: 3_000, burst: 3 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  async fetchAccount(context) {
    if (context.secret === null) {
      throw new SignInRejectedError("Sign in to OmaPosti first.");
    }
    return fetchPostiAccount(context, context.secret, (raw, code) =>
      trackingSnapshot(raw, code, (kind, key) => {
        context.reportUnknown(kind, key);
      }),
    );
  },
});
