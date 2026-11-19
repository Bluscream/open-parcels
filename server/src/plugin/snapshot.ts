import type { Direction, ParcelStatus } from "../domain/parcel.js";
import type { LiveTarget } from "./live.js";

/** One history entry as the carrier reports it. `status` is null when the raw value did not map. */
export interface SnapshotEvent {
  readonly at: string;
  readonly status: ParcelStatus | null;
  readonly rawStatus: string;
  readonly location: string | null;
  /**
   * The source's own identity for this entry (a mail's Message-ID), when it has one. The stored
   * entry is then deduplicated on it instead of on time and text, so one mail is one entry.
   */
  readonly id?: string;
}

export interface SnapshotItem {
  readonly title: string;
  /** Remote image URL; the server serves it through its image proxy, never directly. */
  readonly imageUrl: string | null;
  readonly url: string | null;
  readonly externalId: string | null;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly currency: string | null;
}

/**
 * What a source knows about one parcel at one moment. Plug-ins return these; only the reconciler
 * turns them into stored parcels and events. Unknown values are null, never guessed.
 */
export interface ParcelSnapshot {
  /** Carrier id of the company physically carrying the parcel (`dhl`, `amazon`, …). */
  readonly carrier: string;
  readonly barcode: string;
  readonly direction: Direction;
  /** Mapped status, or null when the carrier's latest value is unknown to us. */
  readonly status: ParcelStatus | null;
  readonly rawStatus: string | null;
  readonly delivered: boolean;
  readonly deliveredAt: string | null;
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
  readonly pickup: boolean;
  readonly pickupPoint: string | null;
  readonly url: string | null;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly weightKg: number | null;
  readonly history: readonly SnapshotEvent[];
  readonly items: readonly SnapshotItem[];
  readonly order: {
    readonly shop: string;
    readonly orderNumber: string;
    readonly placedAt: string | null;
  } | null;
  /** The source's own reference for this parcel (order line, shipment id), if different from the barcode. */
  readonly externalRef: string | null;
  /**
   * Set by shops when another carrier delivers the parcel. The reconciler then files this snapshot
   * under that carrier's parcel, so the shop and the carrier never produce two entries.
   */
  readonly handoff: { readonly carrier: string; readonly barcode: string } | null;
  /** The raw payload, stored separately. Must not contain codes that open or sign in to anything. */
  readonly raw: unknown;
  /** Set when the carrier can show the courier on a map for this parcel. Kept in memory only. */
  readonly live: LiveTarget | null;
}

/** Fills the optional parts of a snapshot with nulls, so plug-ins only spell out what they know. */
export function snapshot(
  required: Pick<ParcelSnapshot, "carrier" | "barcode" | "status" | "rawStatus"> &
    Partial<ParcelSnapshot>,
): ParcelSnapshot {
  return {
    direction: "incoming",
    delivered: required.status === "delivered",
    deliveredAt: null,
    plannedFrom: null,
    plannedTo: null,
    pickup: false,
    pickupPoint: null,
    url: null,
    sender: null,
    receiver: null,
    weightKg: null,
    history: [],
    items: [],
    order: null,
    externalRef: null,
    handoff: null,
    raw: null,
    live: null,
    ...required,
  };
}
