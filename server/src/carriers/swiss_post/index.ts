import { z } from "zod";
import {
  asObject,
  defineCarrier,
  RateLimitedError,
  readJson,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginLogger,
} from "../../plugin/api.js";
import { CARRIER_ID, shipmentSnapshot } from "./parse.js";
import { HOST, LABEL, TrackerSession } from "./session.js";

const CODE_PATTERN = /^[A-Z0-9.]{8,40}$/i;
/** The wording table is the same for every parcel, about 130 KB; refreshed once a day. */
const TEXTS_TTL_MS = 24 * 60 * 60 * 1000;

const configSchema = z.looseObject({
  /** Fetch each parcel's event timeline too, one extra request per parcel. Default on. */
  eventHistory: z.boolean().optional(),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

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

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
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
      snapshots.push(shipmentSnapshot(raw, timeline, texts, report));
    }
  } finally {
    await session.save(context.session);
  }
  return { snapshots, complete: true };
}

/** Test hook: forget the cached wording table. */
export function resetWordingCache(): void {
  textCache = null;
}

export const swissPost = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Swiss Post",
  countries: ["CH", "LI"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 4_000, burst: 3 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
