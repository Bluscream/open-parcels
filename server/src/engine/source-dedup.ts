import type { Kysely, Transaction } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendSourceRemoved } from "./sources.js";

type Trx = Transaction<Database>;

/** Prefix of the settings rows the Home Assistant importer keeps per imported entry. */
const HA_MARKER_PREFIX = "ha_import:";

/** Moves everything that points at `from` over to `into`, skipping what `into` already has. */
async function moveLinks(trx: Trx, from: string, into: string): Promise<void> {
  await trx
    .insertInto("parcel_sources")
    .columns(["parcel_id", "source_id", "external_ref", "role", "last_seen_at", "missing_since"])
    .expression((eb) =>
      eb
        .selectFrom("parcel_sources")
        .select([
          "parcel_id",
          eb.val(into).as("source_id"),
          "external_ref",
          "role",
          "last_seen_at",
          "missing_since",
        ])
        .where("source_id", "=", from),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  await trx
    .updateTable("parcel_events")
    .set({ source_id: into })
    .where("source_id", "=", from)
    .execute();
  await trx
    .insertInto("parcel_raw")
    .columns(["parcel_id", "source_id", "fetched_at", "payload"])
    .expression((eb) =>
      eb
        .selectFrom("parcel_raw")
        .select(["parcel_id", eb.val(into).as("source_id"), "fetched_at", "payload"])
        .where("source_id", "=", from),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Points Home Assistant import markers at the surviving source, marked adopted, so a re-import
 * keeps it as it is instead of creating the duplicate again.
 */
async function moveMarkers(trx: Trx, from: string, into: string): Promise<void> {
  const markers = await trx
    .selectFrom("settings")
    .select(["key", "value"])
    .where("key", "like", `${HA_MARKER_PREFIX}%`)
    .execute();
  for (const marker of markers) {
    const value = JSON.parse(marker.value) as { sourceId?: unknown };
    if (value.sourceId === from) {
      await trx
        .updateTable("settings")
        .set({ value: JSON.stringify({ ...value, sourceId: into, adopted: true }) })
        .where("key", "=", marker.key)
        .execute();
    }
  }
}

/**
 * Merges keyless tracking sources of the same plug-in into the oldest one, which keeps its id and
 * label. A keyless tracking source holds nothing of its own, so two of them (one created on first
 * use, one imported from Home Assistant) only split the parcels and the polling. Sources with a
 * key are left alone: each key is its own quota. Idempotent; returns how many were merged.
 */
export async function mergeDuplicateTrackingSources(
  db: Kysely<Database>,
  clock: Clock,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("sources")
      .select(["id", "plugin", "label", "kind"])
      .where("kind", "=", "tracking")
      .where("secret_blob", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const keep = new Map<string, string>();
    let merged = 0;
    for (const row of rows) {
      const into = keep.get(row.plugin);
      if (into === undefined) {
        keep.set(row.plugin, row.id);
        continue;
      }
      await moveLinks(trx, row.id, into);
      await moveMarkers(trx, row.id, into);
      await trx.deleteFrom("sources").where("id", "=", row.id).execute();
      await appendSourceRemoved(trx, clock, row, into);
      merged += 1;
    }
    return merged;
  });
}
