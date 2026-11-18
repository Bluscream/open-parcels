import { sql, type Kysely } from "kysely";

/* Migrations receive an untyped Kysely: the typed schema describes the latest state, while each
 * migration must keep describing the state it was written against. */

async function createAuthTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("owner")
    .addColumn("id", "integer", (c) => c.primaryKey().check(sql`id = 1`))
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("sessions")
    .addColumn("id_hash", "text", (c) => c.primaryKey())
    .addColumn("csrf_token", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("expires_at", "text", (c) => c.notNull())
    .addColumn("last_seen_at", "text", (c) => c.notNull())
    .addColumn("user_agent", "text")
    .execute();

  await db.schema
    .createTable("api_tokens")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("scopes", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("last_used_at", "text")
    .addColumn("expires_at", "text")
    .execute();

  await db.schema
    .createTable("settings")
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
}

async function createSourceTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sources")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("plugin", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) =>
      c.notNull().check(sql`kind in ('account', 'tracking', 'shop', 'mail')`),
    )
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("config", "text", (c) => c.notNull().defaultTo("{}"))
    .addColumn("secret_blob", "blob")
    .addColumn("session_blob", "blob")
    .addColumn("state", "text", (c) =>
      c.notNull().check(sql`state in ('ok', 'needs_sign_in', 'error', 'disabled')`),
    )
    .addColumn("state_detail", "text")
    .addColumn("consecutive_failures", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("backoff_until", "text")
    .addColumn("next_run_at", "text")
    .addColumn("last_run_at", "text")
    .addColumn("last_ok_at", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("orders")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("shop", "text", (c) => c.notNull())
    .addColumn("order_number", "text", (c) => c.notNull())
    .addColumn("placed_at", "text")
    .addColumn("status", "text")
    .addColumn("created_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .addUniqueConstraint("orders_shop_number", ["shop", "order_number"])
    .execute();
}

async function createParcelTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("parcels")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("carrier", "text", (c) => c.notNull())
    .addColumn("barcode", "text", (c) => c.notNull())
    .addColumn("direction", "text", (c) =>
      c.notNull().check(sql`direction in ('incoming', 'outgoing')`),
    )
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("raw_status", "text")
    .addColumn("delivered", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("delivered_at", "text")
    .addColumn("planned_from", "text")
    .addColumn("planned_to", "text")
    .addColumn("pickup", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("pickup_point", "text")
    .addColumn("url", "text")
    .addColumn("sender", "text")
    .addColumn("receiver", "text")
    .addColumn("weight_kg", "real")
    .addColumn("dimensions", "text")
    .addColumn("label", "text")
    .addColumn("order_id", "text", (c) => c.references("orders.id").onDelete("set null"))
    .addColumn("manual_status", "text")
    .addColumn("manual_until", "text")
    .addColumn("first_seen_at", "text", (c) => c.notNull())
    .addColumn("last_seen_at", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .addColumn("removed_at", "text")
    .addColumn("archived_at", "text")
    .addUniqueConstraint("parcels_carrier_barcode", ["carrier", "barcode"])
    .execute();

  await db.schema
    .createTable("parcel_sources")
    .addColumn("parcel_id", "text", (c) => c.notNull().references("parcels.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("external_ref", "text")
    .addColumn("role", "text", (c) =>
      c.notNull().check(sql`role in ('primary', 'handoff', 'mail')`),
    )
    .addColumn("last_seen_at", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("parcel_sources_pk", ["parcel_id", "source_id"])
    .execute();

  await db.schema
    .createTable("parcel_events")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("parcel_id", "text", (c) => c.notNull().references("parcels.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.references("sources.id").onDelete("set null"))
    .addColumn("at", "text", (c) => c.notNull())
    .addColumn("status", "text")
    .addColumn("raw_status", "text", (c) => c.notNull())
    .addColumn("location_text", "text")
    .addColumn("fingerprint", "text", (c) => c.notNull())
    .addUniqueConstraint("parcel_events_fingerprint", ["parcel_id", "fingerprint"])
    .execute();

  await db.schema
    .createTable("parcel_raw")
    .addColumn("parcel_id", "text", (c) => c.notNull().references("parcels.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("fetched_at", "text", (c) => c.notNull())
    .addColumn("payload", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("parcel_raw_pk", ["parcel_id", "source_id"])
    .execute();

  await db.schema
    .createTable("items")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("parcel_id", "text", (c) => c.notNull().references("parcels.id").onDelete("cascade"))
    .addColumn("position", "integer", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("image_ref", "text")
    .addColumn("url", "text")
    .addColumn("external_id", "text")
    .addColumn("quantity", "integer")
    .addColumn("price", "real")
    .addColumn("currency", "text")
    .execute();

  await db.schema
    .createTable("live_state")
    .addColumn("parcel_id", "text", (c) =>
      c.primaryKey().references("parcels.id").onDelete("cascade"),
    )
    .addColumn("state", "text", (c) =>
      c.notNull().check(sql`state in ('en_route', 'next_stop', 'delivered', 'ended')`),
    )
    .addColumn("stops_away", "integer")
    .addColumn("message", "text")
    .addColumn("position_at", "text")
    .addColumn("updated_at", "text", (c) => c.notNull())
    .execute();
}

async function createSupportTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("places")
    .addColumn("key", "text", (c) => c.primaryKey())
    .addColumn("latitude", "real")
    .addColumn("longitude", "real")
    .addColumn("precision", "text")
    .addColumn("resolved_at", "text")
    .addColumn("missed_at", "text")
    .execute();

  await db.schema
    .createTable("outbox")
    .addColumn("seq", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("parcel_id", "text")
    .addColumn("payload", "text", (c) => c.notNull())
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("unknown_vocab")
    .addColumn("plugin", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("first_seen_at", "text", (c) => c.notNull())
    .addColumn("last_seen_at", "text", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("unknown_vocab_pk", ["plugin", "kind", "key"])
    .execute();

  await db.schema
    .createTable("image_cache")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("source_url", "text", (c) => c.notNull())
    .addColumn("content_type", "text")
    .addColumn("bytes", "integer")
    .addColumn("fetched_at", "text")
    .addColumn("expires_at", "text")
    .execute();
}

async function createIndexes(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("parcels_active")
    .on("parcels")
    .columns(["delivered", "archived_at"])
    .execute();
  await db.schema
    .createIndex("parcel_events_parcel_at")
    .on("parcel_events")
    .columns(["parcel_id", "at"])
    .execute();
  await db.schema
    .createIndex("parcel_sources_source")
    .on("parcel_sources")
    .column("source_id")
    .execute();
  await db.schema
    .createIndex("items_parcel")
    .on("items")
    .columns(["parcel_id", "position"])
    .execute();
  await db.schema.createIndex("outbox_created").on("outbox").column("created_at").execute();
  await db.schema.createIndex("sessions_expires").on("sessions").column("expires_at").execute();
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await createAuthTables(db);
  await createSourceTables(db);
  await createParcelTables(db);
  await createSupportTables(db);
  await createIndexes(db);
}
