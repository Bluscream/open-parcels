import type { Kysely } from "kysely";

/** Why the app archived a parcel on its own (e.g. a mail that was not a shipment); null otherwise. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("parcels").addColumn("archive_reason", "text").execute();
}
