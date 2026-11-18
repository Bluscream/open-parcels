import { sql, type Kysely } from "kysely";

/**
 * What the carrier said the last time a tracking source asked about a parcel, so a code the
 * carrier does not know is visible instead of silently staying `registered`:
 * - `lookup_state`: `pending` (never answered), `found` or `not_found`;
 * - `lookup_since`: when the current state began;
 * - `lookup_checked_at`: when a carrier was last asked.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("parcels")
    .addColumn("lookup_state", "text", (c) => c.notNull().defaultTo(sql`'pending'`))
    .execute();
  await db.schema.alterTable("parcels").addColumn("lookup_since", "text").execute();
  await db.schema.alterTable("parcels").addColumn("lookup_checked_at", "text").execute();
}
