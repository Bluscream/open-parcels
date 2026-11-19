import type { Kysely } from "kysely";

/**
 * Sessions know their role: `admin` (signed in with the admin password, may change anything) or
 * `reader` (signed in with OPENPARCELS_PASSWORD, may only read). Every session before this was
 * the owner's, so existing ones become admin sessions and nobody is signed out by the upgrade.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sessions")
    .addColumn("role", "text", (c) => c.notNull().defaultTo("admin"))
    .execute();
}
