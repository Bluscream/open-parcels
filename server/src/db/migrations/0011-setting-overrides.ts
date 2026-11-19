import type { Kysely } from "kysely";

/**
 * Values of OPENPARCELS_* settings saved on the Settings page. Each wins over the environment
 * until it is reset (the row deleted). `value` is JSON.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("setting_overrides")
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
}
