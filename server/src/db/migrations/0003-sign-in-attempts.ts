import type { Kysely } from "kysely";

/**
 * Interactive sign-ins in progress. The plug-in's state and the current step are one encrypted
 * blob (cookies, verifiers, sometimes a typed password); everything else is bookkeeping. One
 * attempt per source at a time; rows go when the sign-in finishes, is cancelled or expires.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sign_in_attempts")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("flow", "text", (c) => c.notNull())
    .addColumn("blob", "blob", (c) => c.notNull())
    .addColumn("failures", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("poll_not_before", "text")
    .execute();
  await db.schema
    .createIndex("sign_in_attempts_source")
    .on("sign_in_attempts")
    .column("source_id")
    .execute();
}
