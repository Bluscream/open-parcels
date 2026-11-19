import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import * as m0001 from "../../src/db/migrations/0001-initial.js";
import * as m0002 from "../../src/db/migrations/0002-reconciler.js";
import * as m0003 from "../../src/db/migrations/0003-sign-in-attempts.js";
import * as m0004 from "../../src/db/migrations/0004-lookup-state.js";
import * as m0005 from "../../src/db/migrations/0005-archive-reason.js";
import * as m0006 from "../../src/db/migrations/0006-auto-created-sources.js";
import * as m0007 from "../../src/db/migrations/0007-event-coordinates.js";
import * as m0008 from "../../src/db/migrations/0008-order-items.js";

const BEFORE_IDLE: Readonly<Record<string, Migration>> = {
  "0001-initial": m0001,
  "0002-reconciler": m0002,
  "0003-sign-in-attempts": m0003,
  "0004-lookup-state": m0004,
  "0005-archive-reason": m0005,
  "0006-auto-created-sources": m0006,
  "0007-event-coordinates": m0007,
  "0008-order-items": m0008,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function insertSource(
  db: Kysely<unknown>,
  id: string,
  state: string,
  detail: string | null,
): Promise<void> {
  await sql`
    insert into sources (id, plugin, kind, label, state, state_detail, created_at, updated_at, auto_created)
    values (${id}, 'dpd', 'tracking', ${id}, ${state}, ${detail}, 't', 't', 1)
  `.execute(db);
}

describe("migration 0009-idle-source-state", () => {
  it("turns OK rows that ran idle into idle, keeps every other row and its links", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-migrate-"));
    dirs.push(dir);
    const { db } = openDatabase(path.join(dir, "db.sqlite"));
    const raw = db as unknown as Kysely<unknown>;
    try {
      const old = new Migrator({
        db,
        provider: { getMigrations: () => Promise.resolve(BEFORE_IDLE) },
      });
      expect((await old.migrateToLatest()).error).toBeUndefined();
      await insertSource(raw, "idle", "ok", "Public tracking off: nothing to look up.");
      await insertSource(raw, "fresh", "ok", "Not run yet.");
      await insertSource(raw, "fine", "ok", null);
      await insertSource(raw, "broken", "error", "Boom.");
      await sql`
        insert into sign_in_attempts (id, source_id, flow, blob, created_at, expires_at)
        values ('a1', 'fine', 'f', x'00', 't', 't')
      `.execute(raw);

      expect(await migrateToLatest(db)).toEqual([
        "0009-idle-source-state",
        "0010-order-lifecycle",
        "0011-setting-overrides",
        "0012-session-roles",
        "0013-geocoded-events",
      ]);

      const rows = await sql<{ id: string; state: string; state_detail: string | null }>`
        select id, state, state_detail from sources order by id
      `.execute(raw);
      expect(rows.rows).toEqual([
        { id: "broken", state: "error", state_detail: "Boom." },
        { id: "fine", state: "ok", state_detail: null },
        { id: "fresh", state: "ok", state_detail: "Not run yet." },
        { id: "idle", state: "idle", state_detail: "Public tracking off: nothing to look up." },
      ]);
      // The rebuild did not cascade into rows that point at a source.
      const attempts = await sql`select id from sign_in_attempts`.execute(raw);
      expect(attempts.rows).toHaveLength(1);
      // Foreign keys are back on and still enforced.
      const fk = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(raw);
      expect(fk.rows[0]?.foreign_keys).toBe(1);
      await sql`delete from sources where id = 'fine'`.execute(raw);
      expect((await sql`select id from sign_in_attempts`.execute(raw)).rows).toHaveLength(0);
      // The constraint still rejects unknown states.
      await expect(insertSource(raw, "bad", "sleepy", null)).rejects.toThrow(/CHECK/);
    } finally {
      await db.destroy();
    }
  });
});
