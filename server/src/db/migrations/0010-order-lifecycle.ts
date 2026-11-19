import { sql, type Kysely } from "kysely";

/**
 * Orders become something the owner manages:
 * - `label`: an own name for the order, null for the shop's.
 * - `archive_mode`: null while archiving is automatic (archived once every parcel is), `archived`
 *   when archived by hand, `kept` when taken out of the archive by hand. `archived_at` is when it
 *   was archived by hand.
 * - `deleted_at`: a deleted order is kept as a tombstone, so a shop that lists it again does not
 *   bring it back; its parcels are unlinked and its lines removed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("orders").addColumn("label", "text").execute();
  await db.schema
    .alterTable("orders")
    .addColumn("archive_mode", "text", (c) => c.check(sql`archive_mode in ('archived', 'kept')`))
    .execute();
  await db.schema.alterTable("orders").addColumn("archived_at", "text").execute();
  await db.schema.alterTable("orders").addColumn("deleted_at", "text").execute();
}
