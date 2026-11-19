import { z } from "zod";
import {
  carrierPattern,
  asObject,
  asTracked,
  defineCarrier,
  RateLimitedError,
  SignInRejectedError,
  readJson,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginLogger,
} from "../../plugin/api.js";
import { accountSignIn, APP_HOST, fetchSwissPostAccount, LOGIN_HOST } from "./account.js";
import { CARRIER_ID, shipmentSnapshot } from "./parse.js";
import { HOST, LABEL, TrackerSession } from "./session.js";

const CODE_PATTERN = carrierPattern("swiss_post");
/** The wording table is the same for every parcel, about 130 KB; refreshed once a day. */
const TEXTS_TTL_MS = 24 * 60 * 60 * 1000;

const configSchema = z.looseObject({
  /** Fetch each parcel's event timeline too, one extra request per parcel. Default on. */
  eventHistory: z.boolean().optional(),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z
  .object({ refreshToken: z.string().min(1), deviceId: z.string().min(1) })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

let textCache: { readonly at: number; readonly texts: ReadonlyMap<string, string> } | null = null;

/** The wording table; a failure costs wording only (events then show their code). */
async function wordingTable(
  session: TrackerSession,
  now: number,
  logger: PluginLogger,
): Promise<ReadonlyMap<string, string>> {
  if (textCache !== null && now - textCache.at < TEXTS_TTL_MS) {
    return textCache.texts;
  }
  const texts = new Map<string, string>();
  try {
    const response = await session.get("/core/rest/translations/en/shipment-text-messages");
    const section =
      response.status === 200
        ? asObject(readJson(response, `${LABEL} wording`))["shipment-text--"]
        : null;
    for (const [key, value] of Object.entries(asObject(section))) {
      if (typeof value === "string") {
        texts.set(key, value);
      }
    }
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw error;
    }
    logger.debug(
      { error: error instanceof Error ? error.name : "unknown" },
      "Swiss Post wording unavailable.",
    );
  }
  textCache = { at: now, texts };
  return texts;
}

/** The event timeline; a failure never fails the parcel, only a rate limit stops the run. */
async function events(
  session: TrackerSession,
  identity: string,
  logger: PluginLogger,
): Promise<Json[]> {
  try {
    const response = await session.get(`/api/shipment/id/${encodeURIComponent(identity)}/events`);
    const payload = response.status === 200 ? readJson(response, `${LABEL} events`) : null;
    return Array.isArray(payload) ? payload.map(asObject) : [];
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw error;
    }
    logger.debug(
      { error: error instanceof Error ? error.name : "unknown" },
      "Swiss Post events unavailable.",
    );
    return [];
  }
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const session = TrackerSession.restore(context.http, context.session);
  const withHistory = context.config.eventHistory !== false;
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  try {
    for (const barcode of barcodes) {
      if (!CODE_PATTERN.test(barcode)) {
        continue;
      }
      const first: unknown = (await session.lookUp(barcode))[0];
      if (typeof first !== "object" || first === null) {
        continue;
      }
      const raw = first as Json;
      const identity = raw["identity"];
      const timeline =
        withHistory && typeof identity === "string"
          ? await events(session, identity, context.logger)
          : [];
      const texts =
        timeline.length > 0
          ? await wordingTable(session, context.clock.now().getTime(), context.logger)
          : new Map<string, string>();
      // Filed under the code tracked; Swiss Post's shipment number may be missing or spelled
      // differently, and is kept as the reference.
      snapshots.push(asTracked(shipmentSnapshot(raw, timeline, texts, report), barcode));
    }
  } finally {
    await session.save(context.session);
  }
  return { snapshots, complete: false };
}

/** Test hook: forget the cached wording table. */
export function resetWordingCache(): void {
  textCache = null;
}

export const swissPost = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Swiss Post",
  countries: ["CH", "LI"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [accountSignIn<Config>(), { type: "none", kinds: ["tracking"] }],
  http: {
    limits: {
      [HOST]: { intervalMs: 4_000, burst: 3 },
      [LOGIN_HOST]: { intervalMs: 10_000, burst: 2 },
      [APP_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
  async fetchAccount(context) {
    if (context.secret === null) {
      throw new SignInRejectedError("Sign in to your Swiss Post account first.");
    }
    return fetchSwissPostAccount(context, context.secret);
  },
});
