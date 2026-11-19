import { sql, type Kysely } from "kysely";

/**
 * `order_items`: what was ordered, per order. `parcel_id` is set once it is known which parcel
 * carries the item; until then the item belongs to the order only. The parcel items stored so
 * far are copied over with their parcel, for parcels that belong to an order.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("order_items")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("order_id", "text", (c) => c.notNull().references("orders.id").onDelete("cascade"))
    .addColumn("position", "integer", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("image_ref", "text")
    .addColumn("url", "text")
    .addColumn("external_id", "text")
    .addColumn("quantity", "integer")
    .addColumn("price", "real")
    .addColumn("currency", "text")
    .addColumn("parcel_id", "text", (c) => c.references("parcels.id").onDelete("set null"))
    .execute();
  await db.schema
    .createIndex("order_items_order")
    .on("order_items")
    .columns(["order_id", "position"])
    .execute();
  await sql`
    INSERT INTO order_items
      (order_id, position, title, image_ref, url, external_id, quantity, price, currency, parcel_id)
    SELECT parcels.order_id, items.position, items.title, items.image_ref, items.url,
           items.external_id, items.quantity, items.price, items.currency, items.parcel_id
    FROM items JOIN parcels ON parcels.id = items.parcel_id
    WHERE parcels.order_id IS NOT NULL
    ORDER BY parcels.order_id, items.parcel_id, items.position
  `.execute(db);
}
