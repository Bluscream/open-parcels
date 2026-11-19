import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import * as m0001 from "./migrations/0001-initial.js";
import * as m0002 from "./migrations/0002-reconciler.js";
import * as m0003 from "./migrations/0003-sign-in-attempts.js";
import * as m0004 from "./migrations/0004-lookup-state.js";
import * as m0005 from "./migrations/0005-archive-reason.js";
import * as m0006 from "./migrations/0006-auto-created-sources.js";
import * as m0007 from "./migrations/0007-event-coordinates.js";
import * as m0008 from "./migrations/0008-order-items.js";
import * as m0009 from "./migrations/0009-idle-source-state.js";
import * as m0010 from "./migrations/0010-order-lifecycle.js";
import * as m0011 from "./migrations/0011-setting-overrides.js";
import type { Database } from "./schema.js";

/**
 * Migrations are listed explicitly rather than read from a folder: the build output stays
 * self-contained and a missing file is a compile error, not a silent skip.
 */
const MIGRATIONS: Readonly<Record<string, Migration>> = {
  "0001-initial": m0001,
  "0002-reconciler": m0002,
  "0003-sign-in-attempts": m0003,
  "0004-lookup-state": m0004,
  "0005-archive-reason": m0005,
  "0006-auto-created-sources": m0006,
  "0007-event-coordinates": m0007,
  "0008-order-items": m0008,
  "0009-idle-source-state": m0009,
  "0010-order-lifecycle": m0010,
  "0011-setting-overrides": m0011,
};

const staticProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

export interface OpenedDatabase {
  readonly db: Kysely<Database>;
  readonly sqlite: SQLite.Database;
}

/** Opens (or creates) the database file with the pragmas this app relies on. */
export function openDatabase(file: string): OpenedDatabase {
  const sqlite = new SQLite(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return { db, sqlite };
}

/** Applies every pending migration; returns the names that ran. */
export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: staticProvider });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((result) => result.status === "Error")?.migrationName ?? "unknown";
    throw new MigrationError(`Database migration ${failed} failed.`, { cause: error });
  }
  return (results ?? [])
    .filter((result) => result.status === "Success")
    .map((result) => result.migrationName);
}
