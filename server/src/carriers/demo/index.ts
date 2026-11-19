import { z } from "zod";
import { defineCarrier, type ParcelSnapshot } from "../../plugin/api.js";
import {
  DEMO_CARRIER,
  DEMO_PARCELS,
  DEMO_SHOP,
  DEMO_SHOP_NAME,
  IMAGE_HOST,
  demoLiveReading,
  type DemoParcel,
} from "./data.js";

/**
 * Demo courier and demo shop: made-up parcels for trying and testing the app (orders, items,
 * history with and without coordinates, a pickup point, a live courier). They never go online
 * except for the placeholder item pictures, fetched through the image proxy.
 */

const configSchema = z.looseObject({});
const secretSchema = z.null();

function snapshot(parcel: DemoParcel, now: number, fromShop: boolean): ParcelSnapshot {
  const built = parcel.build(now);
  return {
    ...built,
    carrier: fromShop ? DEMO_SHOP : DEMO_CARRIER,
    // The shop only knows the order; the courier tracks the parcel and shows it live.
    live: fromShop ? null : built.live,
    items: parcel.items,
    order: {
      shop: DEMO_SHOP_NAME,
      orderNumber: parcel.order.number,
      placedAt: new Date(now - parcel.order.placedHoursAgo * 3_600_000).toISOString(),
    },
    handoff: fromShop ? { carrier: DEMO_CARRIER, barcode: parcel.barcode } : null,
    raw: { demo: true, barcode: parcel.barcode },
  };
}

const LIMITS = { "*": { intervalMs: 1_000, burst: 1 } } as const;

export const demoCarrier = defineCarrier({
  id: DEMO_CARRIER,
  name: "Demo courier",
  countries: ["*"],
  sourceKinds: ["account", "tracking"],
  imageHosts: [IMAGE_HOST],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: { limits: LIMITS },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => snapshot(parcel, now, false)),
      complete: true,
    });
  },
  track: (context, barcodes) => {
    const now = context.clock.now().getTime();
    const wanted = new Set(barcodes.map((code) => code.toUpperCase()));
    return Promise.resolve({
      snapshots: DEMO_PARCELS.filter((parcel) => wanted.has(parcel.barcode)).map((parcel) =>
        snapshot(parcel, now, false),
      ),
      complete: true,
    });
  },
  readLive: (context) => Promise.resolve(demoLiveReading(context.clock.now().getTime())),
});

export const demoShop = defineCarrier({
  id: DEMO_SHOP,
  name: DEMO_SHOP_NAME,
  countries: ["*"],
  sourceKinds: ["shop"],
  imageHosts: [IMAGE_HOST],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: { limits: LIMITS },
  fetchAccount: (context) => {
    const now = context.clock.now().getTime();
    return Promise.resolve({
      snapshots: DEMO_PARCELS.map((parcel) => snapshot(parcel, now, true)),
      complete: true,
    });
  },
});
