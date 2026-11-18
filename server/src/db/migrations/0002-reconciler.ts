import type { Kysely } from "kysely";

/**
 * Columns the reconciler needs:
 * - `parcels.status_at`: timestamp of the newest scan that set the status, so a shop's older
 *   view never overwrites the carrier's newer one;
 * - `parcel_sources.missing_since`: when a complete listing of that source first lacked the
 *   parcel, for the "removed after 6 h" rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("parcels").addColumn("status_at", "text").execute();
  await db.schema.alterTable("parcel_sources").addColumn("missing_since", "text").execute();
}
