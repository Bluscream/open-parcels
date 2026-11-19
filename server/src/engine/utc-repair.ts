import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { fingerprint } from "./reconciler.js";
import { toUtc } from "./utc.js";

const PARCEL_TIMES = ["status_at", "delivered_at", "planned_from", "planned_to"] as const;

/**
 * Rewrites times stored with an offset (`2026-11-18T14:30:00+01:00`) or in a shorter UTC form
 * (`…14:30:00Z`) as canonical UTC (`…13:30:00.000Z`), the one form text comparisons order right. History entries keep their identity: an entry deduplicated on its time
 * gets the fingerprint the UTC time gives, and an entry that then equals one already stored is
 * dropped. Idempotent; returns how many values were rewritten.
 */
export async function rewriteOffsetTimes(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    let rewritten = 0;
    const parcels = await trx
      .selectFrom("parcels")
      .select(["id", ...PARCEL_TIMES])
      .execute();
    for (const row of parcels) {
      const changes: Partial<Record<(typeof PARCEL_TIMES)[number], string | null>> = {};
      for (const column of PARCEL_TIMES) {
        const utc = toUtc(row[column]);
        if (utc !== row[column]) {
          changes[column] = utc;
          rewritten += 1;
        }
      }
      if (Object.keys(changes).length > 0) {
        await trx.updateTable("parcels").set(changes).where("id", "=", row.id).execute();
      }
    }
    const events = await trx
      .selectFrom("parcel_events")
      .select(["id", "parcel_id", "at", "raw_status", "location_text", "fingerprint"])
      .execute();
    for (const event of events) {
      const at = toUtc(event.at);
      if (at === event.at) {
        continue;
      }
      const old = { at: event.at, rawStatus: event.raw_status, location: event.location_text };
      // Only an entry keyed on its time changes key; one keyed on the source's own id keeps it.
      const key =
        fingerprint(old) === event.fingerprint ? fingerprint({ ...old, at }) : event.fingerprint;
      const clash = await trx
        .selectFrom("parcel_events")
        .select("id")
        .where("parcel_id", "=", event.parcel_id)
        .where("fingerprint", "=", key)
        .where("id", "!=", event.id)
        .executeTakeFirst();
      if (clash === undefined) {
        await trx
          .updateTable("parcel_events")
          .set({ at, fingerprint: key })
          .where("id", "=", event.id)
          .execute();
      } else {
        await trx.deleteFrom("parcel_events").where("id", "=", event.id).execute();
      }
      rewritten += 1;
    }
    const orders = await trx
      .selectFrom("orders")
      .select(["id", "placed_at"])
      .where("placed_at", "is not", null)
      .execute();
    for (const order of orders) {
      const placed = toUtc(order.placed_at);
      if (placed !== order.placed_at) {
        await trx
          .updateTable("orders")
          .set({ placed_at: placed })
          .where("id", "=", order.id)
          .execute();
        rewritten += 1;
      }
    }
    return rewritten;
  });
}
