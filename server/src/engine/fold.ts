import type { Transaction } from "kysely";
import type { Clock } from "../clock.js";
import type { Database, ParcelRow } from "../db/schema.js";
import { appendEvent } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, type Presentation } from "../parcels/repository.js";

type Trx = Transaction<Database>;

export interface FoldOptions {
  /** The role the duplicate's links take on the target; kept as they were when absent. */
  readonly linkRole?: "handoff";
}

/**
 * Folds `duplicate` into `target`: history, links, the latest raw payload per source and, where
 * the target has none, items move over, skipping what the target already has. What the user or a
 * shop knew about the duplicate (label, order, manual status and how long it holds) is kept where
 * the target has nothing. The duplicate is then deleted, with `parcel.deleted` naming the target.
 */
export async function foldParcel(
  trx: Trx,
  { clock, presentation }: { readonly clock: Clock; readonly presentation: Presentation },
  duplicate: ParcelRow,
  target: ParcelRow,
  options: FoldOptions = {},
): Promise<void> {
  await trx
    .insertInto("parcel_events")
    .columns([
      "parcel_id",
      "source_id",
      "at",
      "status",
      "raw_status",
      "location_text",
      "latitude",
      "longitude",
      "geocoded",
      "fingerprint",
    ])
    .expression((eb) =>
      eb
        .selectFrom("parcel_events")
        .select([
          eb.val(target.id).as("parcel_id"),
          "source_id",
          "at",
          "status",
          "raw_status",
          "location_text",
          "latitude",
          "longitude",
          "geocoded",
          "fingerprint",
        ])
        .where("parcel_id", "=", duplicate.id),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  await trx
    .insertInto("parcel_sources")
    .columns(["parcel_id", "source_id", "external_ref", "role", "last_seen_at", "missing_since"])
    .expression((eb) =>
      eb
        .selectFrom("parcel_sources")
        .select([
          eb.val(target.id).as("parcel_id"),
          "source_id",
          "external_ref",
          options.linkRole === undefined ? "role" : eb.val(options.linkRole).as("role"),
          "last_seen_at",
          "missing_since",
        ])
        .where("parcel_id", "=", duplicate.id),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  await trx
    .insertInto("parcel_raw")
    .columns(["parcel_id", "source_id", "fetched_at", "payload"])
    .expression((eb) =>
      eb
        .selectFrom("parcel_raw")
        .select([eb.val(target.id).as("parcel_id"), "source_id", "fetched_at", "payload"])
        .where("parcel_id", "=", duplicate.id),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  const targetItems = await trx
    .selectFrom("items")
    .select("id")
    .where("parcel_id", "=", target.id)
    .executeTakeFirst();
  if (targetItems === undefined) {
    await trx
      .updateTable("items")
      .set({ parcel_id: target.id })
      .where("parcel_id", "=", duplicate.id)
      .execute();
  }
  const manualFromTarget = target.manual_status !== null;
  await trx
    .updateTable("parcels")
    .set({
      order_id: target.order_id ?? duplicate.order_id,
      label: target.label ?? duplicate.label,
      manual_status: manualFromTarget ? target.manual_status : duplicate.manual_status,
      manual_until: manualFromTarget ? target.manual_until : duplicate.manual_until,
    })
    .where("id", "=", target.id)
    .execute();
  const gone = await new ParcelRepository(trx, presentation).get(duplicate.id);
  await trx.deleteFrom("parcels").where("id", "=", duplicate.id).execute();
  if (gone !== undefined) {
    await appendEvent(trx, clock, {
      type: "parcel.deleted",
      parcelId: duplicate.id,
      payload: { ...parcelEventPayload({ ...gone, history: [] }), merged_into: target.id },
    });
  }
}
