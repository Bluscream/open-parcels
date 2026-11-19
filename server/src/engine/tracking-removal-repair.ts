import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";

/**
 * Undoes removals that older versions derived from tracking lookups. Tracking sources used to
 * claim complete answers, so a code the carrier did not know yet was marked missing and, six hours
 * later, removed. A parcel is revived only when that path is provable: every link it has is to a
 * tracking source, and at least one of them carries such a missing mark. Every tracking link's
 * mark is cleared too, since a lookup never sets one now. Idempotent; returns the parcels revived.
 */
export async function reviveTrackingRemovals(db: Kysely<Database>, clock: Clock): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const revivable = await trx
      .selectFrom("parcels")
      .select("parcels.id")
      .where("parcels.removed_at", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("parcel_sources")
            .innerJoin("sources", "sources.id", "parcel_sources.source_id")
            .select("parcel_sources.parcel_id")
            .whereRef("parcel_sources.parcel_id", "=", "parcels.id")
            .where("sources.kind", "=", "tracking")
            .where("parcel_sources.missing_since", "is not", null),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("parcel_sources")
              .innerJoin("sources", "sources.id", "parcel_sources.source_id")
              .select("parcel_sources.parcel_id")
              .whereRef("parcel_sources.parcel_id", "=", "parcels.id")
              .where("sources.kind", "!=", "tracking"),
          ),
        ),
      )
      .execute();
    if (revivable.length > 0) {
      await trx
        .updateTable("parcels")
        .set({ removed_at: null, updated_at: isoNow(clock) })
        .where(
          "id",
          "in",
          revivable.map((row) => row.id),
        )
        .execute();
    }
    await trx
      .updateTable("parcel_sources")
      .set({ missing_since: null })
      .where("missing_since", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("sources")
            .select("sources.id")
            .whereRef("sources.id", "=", "parcel_sources.source_id")
            .where("sources.kind", "=", "tracking"),
        ),
      )
      .execute();
    return revivable.length;
  });
}
