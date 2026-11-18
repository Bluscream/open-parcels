import { z } from "zod";
import {
  defineCarrier,
  SignInRejectedError,
  snapshot,
  text,
  trackEach,
  unknownReporter,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { CanadaPostAccount, LIST_HOST, TOKEN_HOST } from "./account.js";
import {
  CARRIER_ID,
  lookUp,
  PLAUSIBLE,
  toSnapshot,
  TRACKING_HOST,
  type Options,
} from "./tracking.js";

const configSchema = z.looseObject({
  /** Zone for dates Canada Post gives without an offset (the delivery day). */
  timeZone: z.string().min(1).optional(),
  language: z.enum(["en", "fr"]).optional(),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

function options(config: Config): Options {
  return { zone: config.timeZone ?? "America/Toronto", lang: config.language ?? "en" };
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  const opts = options(context.config);
  return trackEach(barcodes, PLAUSIBLE, async (pin) => {
    const detail = await lookUp(context.http, pin);
    return detail === null ? null : toSnapshot(detail, pin, opts, report);
  });
}

/** The account lists PINs only; each one's detail comes from the public tracking. */
async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("The Canada Post account needs a username and password.");
  }
  const account = new CanadaPostAccount(
    context.http,
    context.clock,
    context.session,
    context.logger,
  );
  const items = await account.listItems(context.secret);
  const report = unknownReporter(context, "status_code", { once: false });
  const opts = options(context.config);
  const snapshots: ParcelSnapshot[] = [];
  for (const item of items) {
    const pin = text(item["trackId"]) ?? "";
    if (!PLAUSIBLE.test(pin)) {
      continue;
    }
    const detail = await lookUp(context.http, pin);
    snapshots.push(
      detail === null
        ? snapshot({
            carrier: CARRIER_ID,
            barcode: pin,
            status: null,
            rawStatus: null,
            raw: { account: item },
          })
        : toSnapshot({ ...detail, account: item }, pin, opts, report),
    );
  }
  return { snapshots, complete: true };
}

export const canadapost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Canada Post",
  countries: ["CA"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 4_000, burst: 2 },
      [TOKEN_HOST]: { intervalMs: 30_000, burst: 1 },
      [LIST_HOST]: { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  fetchAccount,
});
