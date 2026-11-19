import type { LiveReading, ParcelSnapshot, SnapshotEvent, SnapshotItem } from "../../plugin/api.js";

/**
 * Made-up parcels for trying the app without a real account: three parcels in two orders of the
 * demo shop, carried by the demo courier. Everything is fictional; places are real cities so the
 * map has something to show. Times are relative to "now" but every event carries a fixed id, so a
 * later run never adds the same entry twice.
 */

export const DEMO_CARRIER = "demo";
export const DEMO_SHOP = "demo_shop";
export const DEMO_SHOP_NAME = "Demo shop";
export const IMAGE_HOST = "placehold.co";

const HOUR = 3_600_000;

export interface DemoParcel {
  readonly barcode: string;
  readonly order: { readonly number: string; readonly placedHoursAgo: number };
  readonly items: readonly SnapshotItem[];
  build(now: number): Omit<ParcelSnapshot, "carrier" | "items" | "order" | "handoff" | "raw">;
}

function at(now: number, hoursAgo: number): string {
  return new Date(now - hoursAgo * HOUR).toISOString();
}

/** id, hours ago, status, carrier text, place. */
type EventSpec = readonly [string, number, SnapshotEvent["status"], string, string | null];

function event(
  now: number,
  [id, hoursAgo, status, rawStatus, location]: EventSpec,
  position?: readonly [number, number],
): SnapshotEvent {
  return {
    id: `demo:${id}`,
    at: at(now, hoursAgo),
    status,
    rawStatus,
    location,
    ...(position === undefined ? {} : { latitude: position[0], longitude: position[1] }),
  };
}

function item(title: string, quantity: number, price: number, text: string): SnapshotItem {
  return {
    title,
    imageUrl: `https://${IMAGE_HOST}/160x160/png?text=${encodeURIComponent(text)}`,
    url: null,
    externalId: `demo-${text.toLowerCase()}`,
    quantity,
    price,
    currency: "EUR",
  };
}

const BASE = {
  direction: "incoming",
  url: null,
  sender: "Demo shop",
  receiver: "Erika Musterfrau",
  externalRef: null,
} as const;

/** Delivered yesterday; every scan has coordinates, so the map shows its whole way. */
const delivered: DemoParcel = {
  barcode: "DEMO0000000001",
  order: { number: "DEMO-1001", placedHoursAgo: 72 },
  items: [item("Coffee mug, blue", 2, 12.5, "Mug"), item("Tea towel", 1, 6.9, "Towel")],
  build: (now) => ({
    ...BASE,
    barcode: "DEMO0000000001",
    status: "delivered",
    rawStatus: "Delivered to the recipient",
    delivered: true,
    deliveredAt: at(now, 20),
    plannedFrom: null,
    plannedTo: null,
    pickup: false,
    pickupPoint: null,
    weightKg: 1.2,
    live: null,
    history: [
      event(now, ["1-1", 70, "registered", "Shipment data received", null]),
      event(now, ["1-2", 60, "in_transit", "Picked up", "Munich"], [48.1374, 11.5755]),
      event(now, ["1-3", 48, "in_transit", "Processed at hub", "Leipzig hub"], [51.3397, 12.3731]),
      event(now, ["1-4", 26, "out_for_delivery", "Out for delivery", "Berlin"], [52.52, 13.405]),
      event(
        now,
        ["1-5", 20, "delivered", "Delivered to the recipient", "Berlin-Mitte"],
        [52.5163, 13.3777],
      ),
    ],
  }),
};

/** Out for delivery right now, with a courier moving on the map. Scans name only the city. */
const outForDelivery: DemoParcel = {
  barcode: "DEMO0000000002",
  order: { number: "DEMO-1001", placedHoursAgo: 72 },
  items: [item("Desk lamp", 1, 39.0, "Lamp")],
  build: (now) => ({
    ...BASE,
    barcode: "DEMO0000000002",
    status: "out_for_delivery",
    rawStatus: "Out for delivery",
    delivered: false,
    deliveredAt: null,
    plannedFrom: at(now, 1),
    plannedTo: at(now, -3),
    pickup: false,
    pickupPoint: null,
    weightKg: 2.4,
    live: { ref: { barcode: "DEMO0000000002" }, mapShown: true },
    history: [
      event(now, ["2-1", 50, "registered", "Shipment data received", null]),
      event(now, ["2-2", 30, "in_transit", "Picked up", "Hamburg"]),
      event(now, ["2-3", 12, "in_transit", "Arrived at depot", "Berlin"]),
      event(now, ["2-4", 3, "out_for_delivery", "Out for delivery", "Berlin"]),
    ],
  }),
};

/** Still on its way to a pickup point, with a delivery window and one status no rule maps. */
const toPickupPoint: DemoParcel = {
  barcode: "DEMO0000000003",
  order: { number: "DEMO-1002", placedHoursAgo: 30 },
  items: [item("Paperback novel", 1, 14.99, "Book")],
  build: (now) => ({
    ...BASE,
    barcode: "DEMO0000000003",
    status: "in_transit",
    rawStatus: "Sorted for onward transport",
    delivered: false,
    deliveredAt: null,
    plannedFrom: at(now, -20),
    plannedTo: at(now, -28),
    pickup: true,
    pickupPoint: "Demo parcel locker 42, Alexanderplatz",
    weightKg: 0.4,
    live: null,
    history: [
      event(now, ["3-1", 28, "registered", "Shipment data received", null]),
      event(now, ["3-2", 18, "in_transit", "Picked up", "Cologne"], [50.9375, 6.9603]),
      // Deliberately without a mapped status: shows how unknown wording looks.
      event(now, ["3-3", 6, null, "Sorted for onward transport", "Kassel"]),
    ],
  }),
};

export const DEMO_PARCELS: readonly DemoParcel[] = [delivered, outForDelivery, toPickupPoint];

/** A loop through Berlin-Mitte the demo courier drives every ten minutes. */
const ROUTE: readonly (readonly [number, number])[] = [
  [52.5219, 13.4132],
  [52.5251, 13.4024],
  [52.5208, 13.3925],
  [52.5163, 13.3777],
  [52.5127, 13.3904],
  [52.5154, 13.4048],
];
const LOOP_MS = 10 * 60_000;

/** Where the demo courier is at `now`: between two route points, stops counting down. */
export function demoLiveReading(now: number): LiveReading {
  const progress = (now % LOOP_MS) / LOOP_MS;
  const exact = progress * ROUTE.length;
  const index = Math.floor(exact);
  const from = ROUTE[index % ROUTE.length] ?? ROUTE[0];
  const to = ROUTE[(index + 1) % ROUTE.length] ?? ROUTE[0];
  const share = exact - index;
  const stopsAway = ROUTE.length - 1 - index;
  return {
    state: stopsAway === 0 ? "next_stop" : "en_route",
    stopsAway,
    latitude: (from?.[0] ?? 0) + ((to?.[0] ?? 0) - (from?.[0] ?? 0)) * share,
    longitude: (from?.[1] ?? 0) + ((to?.[1] ?? 0) - (from?.[1] ?? 0)) * share,
    accuracy: 15,
    positionAt: new Date(now).toISOString(),
    message: stopsAway === 0 ? "You are next" : `${String(stopsAway)} stops away`,
  };
}
