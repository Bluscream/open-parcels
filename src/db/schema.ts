import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	source: text("source").notNull(), // e.g. Amazon, eBay
	orderNumber: text("order_number").notNull(),
	status: text("status").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const parcels = sqliteTable("parcels", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	trackingNumber: text("tracking_number").notNull().unique(),
	name: text("name"),
	courier: text("courier"),
	status: text("status").notNull(), // e.g. ordered, sent, arriving, delivered, return
	estimatedDeliveryStart: integer("estimated_delivery_start", {
		mode: "timestamp",
	}),
	estimatedDeliveryEnd: integer("estimated_delivery_end", {
		mode: "timestamp",
	}),
	lat: real("lat"),
	lng: real("lng"),
	orderId: integer("order_id")
		.references(() => orders.id),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const parcelEvents = sqliteTable("parcel_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	parcelId: integer("parcel_id")
		.notNull()
		.references(() => parcels.id),
	location: text("location"),
	description: text("description").notNull(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	lat: real("lat"),
	lng: real("lng"),
	source: text("source"),
});

export const auditLogs = sqliteTable("audit_logs", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	action: text("action").notNull(),
	actor: text("actor").notNull(), // User or System
	details: text("details"),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
});

export const credentials = sqliteTable("credentials", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	service: text("service").notNull().unique(), // e.g. IMAP, Amazon, eBay
	encryptedData: text("encrypted_data").notNull(), // Encrypted JSON string of credentials/tokens
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const settings = sqliteTable("settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
