import { z } from "zod";

/**
 * The canonical status list shared with the Home Assistant parcel suite. Every carrier maps its
 * own vocabulary onto exactly these values, so automations can target `out_for_delivery`
 * regardless of the carrier. Do not extend or rename.
 */
export const PARCEL_STATUSES = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "returning",
  "problem",
  "unknown",
] as const;
export type ParcelStatus = (typeof PARCEL_STATUSES)[number];
export const parcelStatusSchema = z.enum(PARCEL_STATUSES);

export const DIRECTIONS = ["incoming", "outgoing"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** States of a courier map session (parcel-live/1). */
export const LIVE_STATES = ["en_route", "next_stop", "delivered", "ended"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export const LOCATION_SOURCES = ["courier", "event"] as const;
export const LOCATION_PRECISIONS = ["exact", "street", "area"] as const;

const isoDateTime = z.iso.datetime({ offset: true });

export const historyEntrySchema = z.object({
  timestamp: isoDateTime,
  status: parcelStatusSchema.nullable(),
  raw_status: z.string(),
  location: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** parcel-items/1: what is in the parcel. Images are served through the image proxy. */
export const itemSchema = z.object({
  title: z.string(),
  image_url: z.string().nullable(),
  url: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
});
export type Item = z.infer<typeof itemSchema>;

/**
 * parcel-live/1: the courier on the last mile. Coordinates are the courier's, never the
 * destination's, and are null from `next_stop` on.
 */
export const liveSchema = z.object({
  state: z.enum(LIVE_STATES),
  stops_away: z.number().int().nonnegative().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  accuracy: z.number().nonnegative().nullable(),
  position_at: isoDateTime.nullable(),
  message: z.string().nullable(),
  updated_at: isoDateTime,
});
export type Live = z.infer<typeof liveSchema>;

/** parcel-location/1: where the parcel is, as far as anything can tell. */
export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  source: z.enum(LOCATION_SOURCES),
  precision: z.enum(LOCATION_PRECISIONS),
  name: z.string().nullable(),
  address: z.string().nullable(),
  at: isoDateTime.nullable(),
});
export type Location = z.infer<typeof locationSchema>;

export const parcelSourceRefSchema = z.object({
  source_id: z.string(),
  plugin: z.string(),
  role: z.enum(["primary", "handoff", "mail"]),
  last_seen_at: isoDateTime,
});

export const LOOKUP_STATES = ["pending", "found", "not_found"] as const;
export type LookupState = (typeof LOOKUP_STATES)[number];

/**
 * What the carrier said the last time a tracking source asked about the code. `pending`: never
 * answered (or not followed by any tracking source); `not_found`: the carrier was asked and did
 * not return the code. `since` is when the state began, `checked_at` the last time it was asked.
 */
export const lookupSchema = z.object({
  state: z.enum(LOOKUP_STATES),
  since: isoDateTime.nullable(),
  checked_at: isoDateTime.nullable(),
});
export type Lookup = z.infer<typeof lookupSchema>;

/**
 * The normalised parcel every client sees. The first block mirrors the Home Assistant suite's
 * contract key for key; the rest are this service's additions. Keys are never omitted: unknown
 * values are null.
 */
export const parcelSchema = z.object({
  carrier: z.string(),
  barcode: z.string(),
  sender: z.string().nullable(),
  receiver: z.string().nullable(),
  status: parcelStatusSchema,
  raw_status: z.string().nullable(),
  delivered: z.boolean(),
  delivered_at: isoDateTime.nullable(),
  planned_from: isoDateTime.nullable(),
  planned_to: isoDateTime.nullable(),
  pickup: z.boolean(),
  pickup_point: z.string().nullable(),
  history: z.array(historyEntrySchema),
  url: z.string().nullable(),

  id: z.uuid(),
  direction: z.enum(DIRECTIONS),
  label: z.string().nullable(),
  manual_status: parcelStatusSchema.nullable(),
  items: z.array(itemSchema),
  live: liveSchema.nullable(),
  location: locationSchema.nullable(),
  order: z.object({ shop: z.string(), order_number: z.string() }).nullable(),
  sources: z.array(parcelSourceRefSchema),
  lookup: lookupSchema,
  first_seen_at: isoDateTime,
  updated_at: isoDateTime,
});
export type Parcel = z.infer<typeof parcelSchema>;

/** A parcel counts as active until it is delivered; a manual status always wins. */
export function effectiveStatus(parcel: Pick<Parcel, "status" | "manual_status">): ParcelStatus {
  return parcel.manual_status ?? parcel.status;
}
