import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  defineCarrier,
  RateLimitedError,
  SignInRejectedError,
  type ParcelSnapshot,
  type PluginContext,
  type PluginLogger,
} from "../../plugin/api.js";
import { accountSnapshot } from "./account-parcels.js";
import { HermesAccount, readInbox } from "./account.js";
import { ACCOUNT_HOST, CARRIER_ID, TRACKING_HOST } from "./shared.js";
import { isPlausibleBarcode, lookUp, readForecast, trackingSnapshot } from "./tracking.js";

/** Public lookups run at most this many at a time while an account run adds forecasts. */
export const FORECAST_CONCURRENCY = 2;
/** At most this many forecast lookups per account run, newest parcels first in Hermes' order. */
export const FORECAST_LIMIT = 20;

const configSchema = z.looseObject({
  /** Look account parcels up on the public tracking too, for the delivery window. Default on. */
  publicForecast: z.boolean().optional(),
});
type Config = z.infer<typeof configSchema>;

/** Tracking sources need nothing; account sources store the username and password, encrypted. */
const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

/**
 * The account never returns a delivery window; the public tracking does. Lookups run with a
 * small concurrency cap; a failed one leaves its parcel as it was, and a rate limit stops the
 * rest. A forecast never fails the account run.
 */
async function addForecasts(
  http: PluginHttp,
  logger: PluginLogger,
  snapshots: ParcelSnapshot[],
): Promise<ParcelSnapshot[]> {
  const result = [...snapshots];
  const todo = result
    .map((parcel, index) => ({ parcel, index }))
    .filter(({ parcel }) => !parcel.delivered && isPlausibleBarcode(parcel.barcode))
    .slice(0, FORECAST_LIMIT);
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (let next = todo.shift(); next !== undefined && !stopped; next = todo.shift()) {
      try {
        const raw = await lookUp(http, next.parcel.barcode);
        if (raw !== null) {
          result[next.index] = { ...next.parcel, ...readForecast(raw) };
        }
      } catch (error) {
        stopped ||= error instanceof RateLimitedError;
        logger.debug(
          { error: error instanceof Error ? error.name : "unknown" },
          "Hermes forecast lookup failed.",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: FORECAST_CONCURRENCY }, worker));
  return result;
}

async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("The Hermes account needs a username and password.");
  }
  const client = new HermesAccount(context.http, context.logger);
  const raws = await readInbox(client, context.session, context.secret);
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const snapshots = raws
    .map((raw) => accountSnapshot(raw, report))
    .filter((parcel) => parcel !== null);
  const withForecast =
    context.config.publicForecast === false
      ? snapshots
      : await addForecasts(context.http, context.logger, snapshots);
  return { snapshots: withForecast, complete: true };
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  // One at a time: the host limiter paces them, and an error stops the run before more go out.
  for (const barcode of barcodes) {
    if (!isPlausibleBarcode(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(trackingSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const hermes = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Hermes",
  countries: ["DE"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 4_000, burst: 2 },
      [ACCOUNT_HOST]: { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
  track,
});
