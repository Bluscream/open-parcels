import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import {
  InvalidSourceConfigError,
  type PluginRegistry,
  type RegisteredPlugin,
} from "./registry.js";

/** The tracking source of a carrier, created if missing; undefined when no plug-in can track it. */
export type TrackingSourceFor = (carrier: string) => Promise<string | undefined>;

/** True when the plug-in can run with an empty configuration, so a source can be made for it. */
export function acceptsEmptyConfig(plugin: RegisteredPlugin): boolean {
  try {
    plugin.validateConfig({});
    return true;
  } catch (error) {
    if (error instanceof InvalidSourceConfigError) {
      return false;
    }
    throw error;
  }
}

/**
 * The tracking source of a plug-in in `db` (which may be a transaction), created on first use and
 * due at once. Undefined when no installed plug-in can track the carrier, or when its plug-in needs
 * settings (a postcode, a country) that only the user can give; such parcels stay unfollowed until
 * the user adds the source, and are linked to it then.
 */
export function trackingSourceIn(
  db: Kysely<Database>,
  registry: PluginRegistry,
  clock: Clock,
): TrackingSourceFor {
  return async (carrier) => {
    const plugin = registry.get(carrier);
    if (plugin?.canTrack !== true) {
      return undefined;
    }
    const existing = await db
      .selectFrom("sources")
      .select("id")
      .where("plugin", "=", carrier)
      .where("kind", "=", "tracking")
      .orderBy("created_at")
      .executeTakeFirst();
    if (existing !== undefined) {
      return existing.id;
    }
    if (!acceptsEmptyConfig(plugin)) {
      // GLS, Evri and others need a postcode or a country: the user has to add the source.
      return undefined;
    }
    const id = crypto.randomUUID();
    const now = isoNow(clock);
    await db
      .insertInto("sources")
      .values({
        id,
        plugin: carrier,
        kind: "tracking",
        label: `${plugin.info.name} tracking`,
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_detail: null,
        next_run_at: now,
        // Made by the app, not the user: removed again once its last parcel is deleted.
        auto_created: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  };
}

export interface LinkResult {
  readonly sources: ReadonlySet<string>;
  readonly parcels: number;
  /** Carriers whose parcels stayed unfollowed: no plug-in tracks them, or it needs settings. */
  readonly unlinkedCarriers: ReadonlySet<string>;
}

export interface LinkOptions {
  /** Only parcels linked to this source (a mailbox), as the mail watcher's follow-up does. */
  readonly viaSource?: string;
}

/**
 * Links every active parcel (undelivered, not archived, not removed) that no carrier source
 * follows to its carrier's tracking source, the same link `POST /parcels` makes. Idempotent: a
 * parcel already followed is never touched. Returns the tracking sources that gained parcels and
 * how many parcels were linked.
 */
export async function linkUntrackedParcels(
  db: Kysely<Database>,
  clock: Clock,
  sourceFor: TrackingSourceFor,
  options: LinkOptions = {},
): Promise<LinkResult> {
  let query = db
    .selectFrom("parcels")
    .select(["parcels.id", "parcels.carrier"])
    .where("parcels.delivered", "=", 0)
    .where("parcels.archived_at", "is", null)
    .where("parcels.removed_at", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_sources as followed")
            .select("followed.parcel_id")
            .whereRef("followed.parcel_id", "=", "parcels.id")
            .where("followed.role", "in", ["primary", "handoff"]),
        ),
      ),
    );
  if (options.viaSource !== undefined) {
    const via = options.viaSource;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("parcel_sources as via")
          .select("via.parcel_id")
          .whereRef("via.parcel_id", "=", "parcels.id")
          .where("via.source_id", "=", via),
      ),
    );
  }
  const unfollowed = await query.execute();
  const touched = new Set<string>();
  const unlinked = new Set<string>();
  let parcels = 0;
  const byCarrier = new Map<string, string | undefined>();
  for (const parcel of unfollowed) {
    if (!byCarrier.has(parcel.carrier)) {
      byCarrier.set(parcel.carrier, await sourceFor(parcel.carrier));
    }
    const sourceId = byCarrier.get(parcel.carrier);
    if (sourceId === undefined) {
      unlinked.add(parcel.carrier);
      continue;
    }
    await db
      .insertInto("parcel_sources")
      .values({
        parcel_id: parcel.id,
        source_id: sourceId,
        external_ref: null,
        role: "primary",
        last_seen_at: isoNow(clock),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    touched.add(sourceId);
    parcels += 1;
  }
  return { sources: touched, parcels, unlinkedCarriers: unlinked };
}
