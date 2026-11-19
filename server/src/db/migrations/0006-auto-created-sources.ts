import { sql, type Kysely } from "kysely";

/**
 * `sources.auto_created`: 1 for a keyless tracking source the app made on its own when a code was
 * added by hand. Such a source is removed again once its last parcel is deleted. Existing rows
 * stay 0: there is no telling them apart from a source the user made or imported, and those are
 * never removed automatically.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sources")
    .addColumn("auto_created", "integer", (c) => c.notNull().defaultTo(sql`0`))
    .execute();
}
