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
    const orders = await trx.selectFrom("orders").select(["id", "shop", "order_number"]).execute();
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
        .select("id")
        .where("shop", "=", shop)
        .where("order_number", "=", order.order_number)
        .executeTakeFirst();
      if (twin === undefined) {
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
