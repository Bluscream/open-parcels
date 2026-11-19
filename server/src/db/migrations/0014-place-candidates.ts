import type { Kysely } from "kysely";

/**
 * `places` keeps every usable answer for a place name instead of one point: `candidates` is a
 * JSON array of `{label, latitude, longitude, importance}` in the search's order, empty when
 * nothing usable was found (asked again after 30 days from `looked_at`). Which candidate a scan
 * stands for is chosen per parcel from its route (see geo/route-choice.ts).
 *
 * The old rows are dropped rather than converted: each held only the search's first answer, or a
 * miss, and both are wrong for ambiguous names. Every name is looked up again, and events placed
 * from the old rows (`geocoded = 1`) are judged again once their name is.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("places").execute();
  await db.schema
    .createTable("places")
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("candidates", "text", (c) => c.notNull())
    .addColumn("looked_at", "text", (c) => c.notNull())
    .execute();
}
