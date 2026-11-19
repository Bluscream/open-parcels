import { sql, type Kysely } from "kysely";

const OLD_CHECK = "state in ('ok', 'needs_sign_in', 'error', 'disabled')";
const NEW_CHECK = "state in ('ok', 'idle', 'needs_sign_in', 'error', 'disabled')";

/**
 * `sources.state` gains `idle`: the source ran but deliberately did nothing (DPD with public
 * tracking off). It used to be stored as `ok` with the reason in `state_detail`, so clients had to
 * guess from the text.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt from its own stored definition
 * (keeping every column later migrations added). Kysely runs SQLite migrations outside a
 * transaction, which lets foreign keys be switched off for the rebuild: dropping `sources` with
 * them on would cascade into every parcel link.
 *
 * Existing idle rows are the `ok` rows with a detail other than "Not run yet.": a real success
 * always clears the detail.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const stored = await sql<{ sql: string }>`
    select sql from sqlite_master where type = 'table' and name = 'sources'
  `.execute(db);
  const definition = stored.rows[0]?.sql;
  if (definition?.includes(OLD_CHECK) !== true) {
    throw new Error("sources table does not have the expected state constraint");
  }
  const rebuilt = definition
    .replace(OLD_CHECK, NEW_CHECK)
    .replace(/^create table "?sources"?/i, 'create table "sources_rebuild"');

  await sql`pragma foreign_keys = off`.execute(db);
  try {
    await sql`begin`.execute(db);
    try {
      await sql.raw(rebuilt).execute(db);
      await sql`insert into sources_rebuild select * from sources`.execute(db);
      await sql`drop table sources`.execute(db);
      await sql`alter table sources_rebuild rename to sources`.execute(db);
      await sql`
        update sources set state = 'idle'
        where state = 'ok' and state_detail is not null and state_detail != 'Not run yet.'
      `.execute(db);
      const broken = await sql`pragma foreign_key_check`.execute(db);
      if (broken.rows.length > 0) {
        throw new Error("sources rebuild left dangling foreign keys");
      }
      await sql`commit`.execute(db);
    } catch (error) {
      await sql`rollback`.execute(db);
      throw error;
    }
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}
