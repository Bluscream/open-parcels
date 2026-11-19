import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { isPlausibleOrder, shopFromDomain } from "../domain/order.js";

/**
 * Moves orders whose number cannot belong to their shop (an Amazon order without an Amazon order
 * number) to the shop their parcels are named after, else to `unknown`. Only numbers that are
 * provably not the shop's are touched. When the corrected order already exists, the parcels move
 * to it. Idempotent; returns how many orders were corrected.
 */
export async function repairOrderShops(db: Kysely<Database>, clock: Clock): Promise<number> {
  return db.transaction().execute(async (trx) => {
    // A deleted order is a tombstone: never repaired, never a twin to move parcels onto.
    const orders = await trx
      .selectFrom("orders")
      .select(["id", "shop", "order_number"])
      .where("deleted_at", "is", null)
      .execute();
    let repaired = 0;
    for (const order of orders) {
      if (isPlausibleOrder(order.shop, order.order_number)) {
        continue;
      }
      const labels = await trx
        .selectFrom("parcels")
        .select("label")
        .where("order_id", "=", order.id)
        .execute();
      const named = new Set(
        labels.map((row) => shopFromDomain(row.label)).filter((shop) => shop !== null),
      );
      const [only] = named;
      const shop = named.size === 1 && only !== undefined ? only : "unknown";
      const twin = await trx
        .selectFrom("orders")
        .select(["id", "deleted_at"])
        .where("shop", "=", shop)
        .where("order_number", "=", order.order_number)
        .executeTakeFirst();
      if (twin !== undefined && twin.deleted_at !== null) {
        // The user deleted that order: its parcels stay without one.
        await trx
          .updateTable("parcels")
          .set({ order_id: null })
          .where("order_id", "=", order.id)
          .execute();
        await trx.deleteFrom("orders").where("id", "=", order.id).execute();
      } else if (twin === undefined) {
        await trx
          .updateTable("orders")
          .set({ shop, updated_at: isoNow(clock) })
          .where("id", "=", order.id)
          .execute();
      } else {
        await trx
          .updateTable("parcels")
          .set({ order_id: twin.id })
          .where("order_id", "=", order.id)
          .execute();
        await trx.deleteFrom("orders").where("id", "=", order.id).execute();
      }
      repaired += 1;
    }
    return repaired;
  });
}
