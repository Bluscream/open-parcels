import type { Kysely } from "kysely";

/**
 * `parcel_events.latitude` / `longitude`: where a scan happened, for carriers that say. The
 * latest event with a position becomes the parcel's place on the map. Existing rows stay null.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("parcel_events").addColumn("latitude", "real").execute();
  await db.schema.alterTable("parcel_events").addColumn("longitude", "real").execute();
}
