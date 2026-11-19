import { z } from "zod";
import { defineCarrier, type ParcelSnapshot, type SnapshotItem } from "../../plugin/api.js";
import {
  courierView,
  DEMO_CARRIER,
  DEMO_PARCELS,
  DEMO_POLL_MS,
  DEMO_SHOP,
  DEMO_SHOP_NAME,
  GIFT_VOUCHER,
  IMAGE_HOST,
  demoLiveReading,
  runOf,
  type DemoParcel,
} from "./data.js";

/**
 * Demo courier and demo shop: made-up parcels for trying and testing the app, replaying a ten
 * minute story from announced to delivered (see data.ts). They never go online except for the
 * placeholder item pictures, fetched through the image proxy.
 */

const configSchema = z.looseObject({});
const secretSchema = z.null();

const order = (parcel: DemoParcel, now: number): ParcelSnapshot["order"] => ({
  shop: DEMO_SHOP_NAME,
  orderNumber: parcel.order.number,
  placedAt: new Date(runOf(now).start - parcel.order.placedSecondsBefore * 1000).toISOString(),
});

function fromCourier(parcel: DemoParcel, now: number): ParcelSnapshot {
  return {
    ...courierView(parcel, now),
    carrier: DEMO_CARRIER,
    // A courier knows neither the order nor what is inside; the shop does.
    items: [],
    order: null,
    handoff: null,
    raw: { demo: true, barcode: parcel.barcode },
  };
}

/** The shop knows the order and its items and who carries it; the courier knows the rest. */
function fromShop(parcel: DemoParcel, now: number): ParcelSnapshot {
  return {
    carrier: DEMO_SHOP,
    barcode: parcel.barcode,
    direction: "incoming",
    status: null,
    rawStatus: null,
    delivered: false,
    deliveredAt: null,
    plannedFrom: null,
    plannedTo: null,
    pickup: false,
    pickupPoint: null,
    url: null,
    sender: DEMO_SHOP_NAME,
    receiver: null,
    weightKg: null,
    history: [],
    // Drops what an earlier version of the demo shop stored as its own history.
    historyComplete: true,
    items: parcel.items,
    orderItems: orderLines(parcel.order.number),
    order: order(parcel, now),
    externalRef: null,
    handoff: { carrier: DEMO_CARRIER, barcode: parcel.barcode },
    raw: { demo: true, barcode: parcel.barcode },
    live: null,
  };
}

/**
 * Everything in an order: the items of its parcels, plus for DEMO-1001 a gift voucher that the
 * shop lists in no parcel, so it belongs to the order only.
 */
function orderLines(orderNumber: string): SnapshotItem[] {
  const lines = DEMO_PARCELS.filter((parcel) => parcel.order.number === orderNumber).flatMap(
    (parcel) => parcel.items,
  );
  return orderNumber === "DEMO-1001" ? [...lines, GIFT_VOUCHER] : lines;
}

const LIMITS = { "*": { intervalMs: 1_000, burst: 1 } } as const;
const liveRef = z.object({ barcode: z.string() });

export const demoCarrier = defineCarrier({
  id: DEMO_CARRIER,
  name: "Demo courier",
  countries: ["*"],
  sourceKinds: ["account", "tracking"],
  imageHosts: [IMAGE_HOST],
  pollIntervalMs: DEMO_POLL_MS,
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: { limits: LIMITS },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => fromCourier(parcel, now)),
      complete: true,
    });
  },
  track: (context, barcodes) => {
    const now = context.clock.now().getTime();
    const wanted = new Set(barcodes.map((code) => code.toUpperCase()));
    return Promise.resolve({
      snapshots: DEMO_PARCELS.filter((parcel) => wanted.has(parcel.barcode)).map((parcel) =>
        fromCourier(parcel, now),
      ),
      complete: true,
    });
  },
  readLive: (context, target) => {
    const ref = liveRef.safeParse(target.ref);
    return Promise.resolve(
      ref.success ? demoLiveReading(ref.data.barcode, context.clock.now().getTime()) : null,
    );
  },
});

export const demoShop = defineCarrier({
  id: DEMO_SHOP,
  name: DEMO_SHOP_NAME,
  countries: ["*"],
  sourceKinds: ["shop"],
  imageHosts: [IMAGE_HOST],
  pollIntervalMs: DEMO_POLL_MS,
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: { limits: LIMITS },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => fromShop(parcel, now)),
      complete: true,
    });
  },
});
