import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrateToLatest, openDatabase } from "../../src/db/database.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration 0014-place-candidates", () => {
  it("forgets the single-point cache, hits and misses, so every name is looked up again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    const raw = db as unknown as Kysely<unknown>;
    try {
      const before = Object.fromEntries(
        Object.entries(MIGRATIONS).filter(([name]) => name < "0014"),
      );
      const old = new Migrator({ db, provider: { getMigrations: () => Promise.resolve(before) } });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await sql`
        insert into places (key, latitude, longitude, precision, resolved_at, missed_at)
        values ('hamburg', 53.55, 10.0, 'area', 't', null),
               ('greven', null, null, null, null, 't'),
               ('mayong town', null, null, null, null, 't')
      `.execute(raw);

      expect(await migrateToLatest(db)).toEqual(["0014-place-candidates"]);

      expect(await db.selectFrom("places").selectAll().execute()).toEqual([]);
      await db
        .insertInto("places")
        .values({ key: "greven", candidates: "[]", looked_at: "t" })
        .execute();
      expect(await db.selectFrom("places").select("key").execute()).toEqual([{ key: "greven" }]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
