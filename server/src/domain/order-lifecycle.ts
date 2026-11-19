import { z } from "zod";
import {
  locationSchema,
  orderItemSchema,
  parcelStatusSchema,
  DIRECTIONS,
  type ParcelStatus,
} from "./parcel.js";

/**
 * Where an order stands, derived from its parcels in this one place:
 * - `ordered`: no parcel yet, or none has left the shop (registered or unknown);
 * - `partly_shipped` / `shipped`: some / all parcels are on their way;
 * - `partly_delivered` / `delivered`: some / all parcels have arrived;
 * - `problem`: a parcel that has not arrived reports a problem or is going back.
 */
export const ORDER_STATUSES = [
  "ordered",
  "partly_shipped",
  "shipped",
  "partly_delivered",
  "delivered",
  "problem",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

/** Which orders a list shows: open (not delivered), delivered, archived, or all of them. */
export const ORDER_VIEWS = ["open", "delivered", "archived", "all"] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];

/** How an order got (or stays out of) the archive. */
export const ARCHIVE_MODES = ["automatic", "archived", "kept"] as const;
export type ArchiveMode = (typeof ARCHIVE_MODES)[number];

const NOT_SHIPPED: ReadonlySet<ParcelStatus> = new Set(["registered", "unknown"]);
const TROUBLE: ReadonlySet<ParcelStatus> = new Set(["problem", "returning"]);

/** Days after it was placed before an order that never got a parcel is archived. */
export const PARCELLESS_ARCHIVE_DAYS = 30;

export interface ParcelState {
  readonly status: ParcelStatus;
  readonly delivered: boolean;
  readonly archived_at: string | null;
}

export function orderStatus(parcels: readonly ParcelState[]): OrderStatus {
  if (parcels.some((parcel) => !parcel.delivered && TROUBLE.has(parcel.status))) return "problem";
  const delivered = parcels.filter((parcel) => parcel.delivered).length;
  if (parcels.length > 0 && delivered === parcels.length) return "delivered";
  if (delivered > 0) return "partly_delivered";
  const shipped = parcels.filter((parcel) => !NOT_SHIPPED.has(parcel.status)).length;
  if (parcels.length > 0 && shipped === parcels.length) return "shipped";
  return shipped > 0 ? "partly_shipped" : "ordered";
}

/**
 * When the order is archived, or null when it is not. By hand wins either way; otherwise an order
 * follows its parcels: archived once every parcel is (parcels archive themselves after the
 * retention window once delivered), at the moment the last one was. An order that never got a
 * parcel (shops that deliver themselves, digital goods) is archived {@link PARCELLESS_ARCHIVE_DAYS}
 * days after it was placed.
 */
export function orderArchivedAt(
  mode: "archived" | "kept" | null,
  archivedByHand: string | null,
  parcels: readonly ParcelState[],
  placedAt: string | null = null,
  now: Date = new Date(),
): string | null {
  if (mode === "archived") return archivedByHand;
  if (mode === "kept") return null;
  if (parcels.length === 0) {
    if (placedAt === null) return null;
    const due = new Date(Date.parse(placedAt) + PARCELLESS_ARCHIVE_DAYS * 86_400_000);
    return Number.isNaN(due.getTime()) || due > now ? null : due.toISOString();
  }
  let latest = "";
  for (const parcel of parcels) {
    if (parcel.archived_at === null) return null;
    if (parcel.archived_at > latest) latest = parcel.archived_at;
  }
  return latest;
}

export function inView(view: OrderView, status: OrderStatus, archived: boolean): boolean {
  switch (view) {
    case "all":
      return true;
    case "archived":
      return archived;
    case "delivered":
      return !archived && status === "delivered";
    case "open":
      return !archived && status !== "delivered";
  }
}

/** Sum of the lines that carry a price, when they all use one currency. */
export function orderTotal(
  items: readonly { price: number | null; quantity: number | null; currency: string | null }[],
): { amount: number; currency: string } | null {
  const priced = items.filter((item) => item.price !== null && item.currency !== null);
  const currency = priced[0]?.currency ?? null;
  if (currency === null || priced.some((item) => item.currency !== currency)) return null;
  const cents = priced.reduce(
    (sum, item) => sum + Math.round((item.price ?? 0) * 100) * (item.quantity ?? 1),
    0,
  );
  return { amount: cents / 100, currency };
}

const isoDateTime = z.iso.datetime({ offset: true });

/** A parcel of an order, as much as an order view needs. */
export const orderParcelSchema = z.object({
  id: z.uuid(),
  carrier: z.string(),
  barcode: z.string(),
  direction: z.enum(DIRECTIONS),
  display_name: z.string(),
  status: parcelStatusSchema,
  delivered: z.boolean(),
  delivered_at: isoDateTime.nullable(),
  planned_from: isoDateTime.nullable(),
  planned_to: isoDateTime.nullable(),
  archived_at: isoDateTime.nullable(),
  location: locationSchema.nullable(),
  url: z.string().nullable(),
});

export const orderSchema = z.object({
  id: z.uuid(),
  shop: z.string(),
  order_number: z.string(),
  /** The owner's name for the order, null for none. */
  label: z.string().nullable(),
  /** The label, else the shop and order number. */
  display_name: z.string(),
  /** When the order was placed, as the shop said; null when unknown. */
  placed_at: z.string().nullable(),
  status: orderStatusSchema,
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  archive_mode: z.enum(ARCHIVE_MODES),
  parcel_count: z.number().int().nonnegative(),
  delivered_count: z.number().int().nonnegative(),
  total: z.object({ amount: z.number(), currency: z.string() }).nullable(),
  items: z.array(orderItemSchema),
  parcels: z.array(orderParcelSchema),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Order = z.infer<typeof orderSchema>;
