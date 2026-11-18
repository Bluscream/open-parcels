import { z } from "zod";
import {
  defineCarrier,
  SignInRejectedError,
  trackEach,
  type PluginContext,
} from "../../plugin/api.js";
import { itSnapshot, plSnapshot } from "./account-parcels.js";
import { readInbox } from "./account.js";
import { finishSignIn, InPostSession, startSignIn } from "./session.js";
import {
  CARRIER_ID,
  INBOX_HOST,
  MARKETS,
  SIGN_IN_HOST,
  TRACKING_COUNTRIES,
  TRACKING_HOST,
} from "./shared.js";
import { BARCODE_PATTERN, lookUp, trackingSnapshot } from "./tracking.js";

const configSchema = z.looseObject({
  /** Account sources: the market the account is registered in. Default Poland. */
  market: z.enum(MARKETS).optional(),
  /** Tracking sources: whose tracking page parcels link to. Default Poland. */
  country: z.enum(TRACKING_COUNTRIES).optional(),
  /** Sign-in page language, e.g. `pl` or `it`; English otherwise. */
  language: z.string().optional(),
});
type Config = z.infer<typeof configSchema>;

/** Tracking sources need nothing; account sources store the refresh token from the sign-in. */
const secretSchema = z
  .object({ refreshToken: z.string().min(1), market: z.enum(MARKETS) })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("Sign in to your InPost account first.");
  }
  const { market, refreshToken } = context.secret;
  const session = new InPostSession(context, refreshToken);
  const inbox = await readInbox(context.http, session, market);
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const toSnapshot = market === "IT" ? itSnapshot : plSnapshot;
  const snapshots = inbox.parcels
    .map((raw) => toSnapshot(raw, report))
    .filter((parcel) => parcel !== null);
  if (!inbox.complete) {
    context.logger.warn({ market }, "InPost's inbox had more pages than we read.");
  }
  return { snapshots, complete: inbox.complete };
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const country = context.config.country ?? "PL";
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  return trackEach(barcodes, BARCODE_PATTERN, async (barcode) => {
    const raw = await lookUp(context.http, barcode);
    return raw === null ? null : trackingSnapshot(raw, barcode, country, report);
  });
}

/**
 * InPost. Tracking uses the keyless public tracking shared by every InPost country. The account
 * lists every parcel addressed to a Polish or Italian account, after a sign-in in the user's
 * own browser (InPost's login page has a captcha the user solves themselves).
 */
export const inpost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "InPost",
  countries: ["PL", "IT", "PT", "GB", "ES"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: {
    type: "pasted_redirect",
    start: ({ config }) => Promise.resolve(startSignIn(config.market ?? "PL", config.language)),
    finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
  },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 5_000, burst: 2 },
      [INBOX_HOST]: { intervalMs: 10_000, burst: 2 },
      [SIGN_IN_HOST]: { intervalMs: 10_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
  track,
});
