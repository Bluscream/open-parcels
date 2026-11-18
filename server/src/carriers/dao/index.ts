import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type FetchResult,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { asObject, isObject, readJson, text, type Json } from "../../plugin/kit/json.js";
import { unknownReporter } from "../../plugin/kit/track.js";
import { CARRIER_ID, toSnapshot } from "./normalize.js";
import { API_HOST, AUTH_HOST, DaoSession, finishSignIn, startSignIn } from "./session.js";

const TRACKING = "/consumer/shipment/tracking/v1/tracking";
const PICKUP_POINTS = "/consumer/shipment/pickup-point/v1/pickup-points";
/** At most this many detail and pickup-point lookups per run; active parcels come first. */
const EXTRA_LOOKUPS = 15;

const configSchema = z.object({
  /** Language of DAO's status texts: Danish or English. */
  language: z.enum(["da", "en"]).default("da"),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.object({ refreshToken: z.string().min(1) });
type Secret = z.infer<typeof secretSchema>;

/** DAO wraps objects and lists inconsistently; both shapes are accepted, nothing else. */
function unwrap(payload: unknown, keys: readonly string[]): unknown {
  if (!isObject(payload)) {
    return payload;
  }
  const key = keys.find((name) => payload[name] !== undefined);
  return key === undefined ? payload : payload[key];
}

async function list(session: DaoSession, language: string): Promise<Json[]> {
  const parcels: Json[] = [];
  for (const bound of ["IN", "OUT"]) {
    const response = await session.get(TRACKING, { bound, archived: "FALSE", lang: language });
    const items = unwrap(readJson(response, "DAO's parcel list"), ["items", "data"]);
    if (!Array.isArray(items)) {
      throw new UnexpectedResponseError("DAO's parcel list is not a list.");
    }
    parcels.push(...items.filter(isObject).map((item) => ({ bound, ...item })));
  }
  return parcels;
}

async function object(session: DaoSession, path: string, query: Record<string, string>) {
  const found = unwrap(readJson(await session.get(path, query), `DAO ${path}`), ["data", "item"]);
  if (!isObject(found)) {
    throw new UnexpectedResponseError("DAO answered without an object.");
  }
  return found;
}

const isActive = (raw: Json): boolean => {
  const type = text(asObject(asObject(raw["lastEvent"])["status"])["statusType"]);
  return type !== "STATUS_OK";
};

/**
 * Adds history and pickup-point names, within a per-run budget. A failed lookup leaves its
 * parcel without them; a rate limit, an odd answer or a refused session stops the run.
 */
async function enrich(
  context: PluginContext<Config, Secret>,
  session: DaoSession,
  parcels: Json[],
) {
  const extras = new Map<Json, { events: unknown; pickupPointName: string | null }>();
  const names = new Map<string, string | null>();
  let budget = EXTRA_LOOKUPS;
  const ordered = [...parcels.filter(isActive), ...parcels.filter((raw) => !isActive(raw))];
  for (const raw of ordered) {
    const id = text(raw["trackingId"]);
    const pickupId = text(asObject(raw["delivery"])["pickupPointId"]);
    let events: unknown = null;
    try {
      if (id !== null && isActive(raw) && budget > 0) {
        budget -= 1;
        events = (
          await object(session, `${TRACKING}/${encodeURIComponent(id)}`, {
            lang: context.config.language,
          })
        )["events"];
      }
      if (pickupId !== null && !names.has(pickupId) && budget > 0) {
        budget -= 1;
        names.set(
          pickupId,
          text(
            (await object(session, `${PICKUP_POINTS}/${encodeURIComponent(pickupId)}`, {}))["name"],
          ),
        );
      }
    } catch (error) {
      // Refusals, rate limits and odd answers stop the run; only plain network trouble is skipped.
      if (!(error instanceof TransientError) || error instanceof UnexpectedResponseError) {
        throw error;
      }
      context.logger.debug({ error: error.name }, "A DAO detail lookup failed.");
    }
    extras.set(raw, {
      events,
      pickupPointName: pickupId === null ? null : (names.get(pickupId) ?? null),
    });
  }
  return extras;
}

async function fetchAccount(context: PluginContext<Config, Secret>): Promise<FetchResult> {
  const session = new DaoSession(context, context.secret.refreshToken);
  const parcels = await list(session, context.config.language);
  const extras = await enrich(context, session, parcels);
  const reports = {
    type: unknownReporter(context, "status_type"),
    code: unknownReporter(context, "status_code"),
  };
  const snapshots = parcels
    .map((raw) =>
      toSnapshot(raw, extras.get(raw) ?? { events: null, pickupPointName: null }, reports),
    )
    .filter((parcel): parcel is ParcelSnapshot => parcel !== null);
  return { snapshots, complete: true };
}

/** DAO (Denmark): the consumer account, signed in through DAO's own login page. */
export const dao = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "DAO",
  countries: ["DK"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: {
    type: "pasted_redirect",
    start: () => Promise.resolve(startSignIn()),
    finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
  },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [AUTH_HOST]: { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
