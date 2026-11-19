import type { Kysely } from "kysely";

/**
 * `parcel_events.geocoded`: 1 when the event's coordinates were looked up from its place name
 * (approximate, the place's centre) rather than given by the carrier. The lookups themselves
 * are cached per normalised place name in `places` (created in 0001, unused until now): a hit
 * keeps its coordinates and `resolved_at`, a miss only `missed_at`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("parcel_events")
    .addColumn("geocoded", "integer", (c) => c.notNull().defaultTo(0))
    .execute();
}
