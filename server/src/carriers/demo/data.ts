import type { LiveReading, ParcelSnapshot, SnapshotEvent, SnapshotItem } from "../../plugin/api.js";

/**
 * Made-up parcels for trying the app without a real account. Every ten minutes the demo starts
 * over: three parcels in two orders go from announced to delivered, with scans (some with
 * coordinates, some with a city only, one the rules do not map), a live courier counting down ten
 * stops, a failed delivery that ends at a pickup point to be collected the next day, and a parcel
 * for a parcel locker. Everything is fictional; places are real cities so the map has something
 * to show.
 */

export const DEMO_CARRIER = "demo";
export const DEMO_SHOP = "demo_shop";
export const DEMO_SHOP_NAME = "Demo shop";
export const IMAGE_HOST = "placehold.co";

/** One run of the story, from announced to delivered. */
export const LOOP_MS = 10 * 60_000;
/** Runs this often, so each step of the story shows up within half a minute. */
export const DEMO_POLL_MS = 30_000;

type Point = readonly [number, number];

const PLACES = {
  munich: [48.1374, 11.5755],
  leipzigHub: [51.3397, 12.3731],
  berlinDepot: [52.4862, 13.4425],
  berlinMitte: [52.5163, 13.3777],
  alexanderplatz: [52.5219, 13.4132],
  parcelShop: [52.5208, 13.4094],
  cologne: [50.9375, 6.9603],
  locker: [52.5251, 13.4024],
} as const satisfies Record<string, Point>;

/** One step of a parcel's story, `at` seconds into the run. */
interface Step {
  readonly id: string;
  readonly at: number;
  readonly status: SnapshotEvent["status"];
  readonly text: string;
  readonly place: string | null;
  readonly point?: Point;
}

/** The courier's drive: from the depot through ten stops to the door. */
interface Drive {
  readonly from: number;
  readonly to: number;
  readonly route: readonly Point[];
}

export interface DemoParcel {
  readonly barcode: string;
  readonly order: { readonly number: string; readonly placedSecondsBefore: number };
  readonly items: readonly SnapshotItem[];
  readonly weightKg: number;
  readonly steps: readonly Step[];
  readonly drive: Drive | null;
  /** Where it ends up to be collected, and from when (seconds into the run). */
  readonly pickup: { readonly name: string; readonly at: number; readonly nextDay: boolean } | null;
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

/** In the order, but in none of its parcels. */
export const GIFT_VOUCHER: SnapshotItem = item("Gift voucher, 20 EUR", 1, 20, "Gift");

/** Ten stops from `from` to `to`, wobbling a little so the line is not straight. */
function stopsBetween(from: Point, to: Point): Point[] {
  const route: Point[] = [];
  for (let stop = 0; stop <= 10; stop += 1) {
    const share = stop / 10;
    const wobble = stop === 0 || stop === 10 ? 0 : (stop % 2 === 0 ? 1 : -1) * 0.004;
    route.push([
      from[0] + (to[0] - from[0]) * share + wobble,
      from[1] + (to[1] - from[1]) * share - wobble,
    ]);
  }
  return route;
}

/** Delivered at the door after a live drive; every scan has coordinates. */
const toTheDoor: DemoParcel = {
  barcode: "DEMO0000000001",
  order: { number: "DEMO-1001", placedSecondsBefore: 3_600 },
  items: [item("Coffee mug, blue", 2, 12.5, "Mug"), item("Tea towel", 1, 6.9, "Towel")],
  weightKg: 1.2,
  steps: [
    { id: "1", at: 0, status: "registered", text: "Shipment data received", place: null },
    {
      id: "2",
      at: 60,
      status: "in_transit",
      text: "Picked up",
      place: "Munich",
      point: PLACES.munich,
    },
    {
      id: "3",
      at: 150,
      status: "in_transit",
      text: "Processed at hub",
      place: "Leipzig hub",
      point: PLACES.leipzigHub,
    },
    {
      id: "4",
      at: 240,
      status: "in_transit",
      text: "Arrived at the delivery depot",
      place: "Berlin",
      point: PLACES.berlinDepot,
    },
    {
      id: "5",
      at: 300,
      status: "out_for_delivery",
      text: "Out for delivery",
      place: "Berlin",
      point: PLACES.berlinDepot,
    },
    {
      id: "6",
      at: 530,
      status: "delivered",
      text: "Delivered to the recipient",
      place: "Berlin-Mitte",
      point: PLACES.berlinMitte,
    },
  ],
  drive: { from: 300, to: 525, route: stopsBetween(PLACES.berlinDepot, PLACES.berlinMitte) },
  pickup: null,
};

/** Nobody home: the courier gives up and it waits at a parcel shop from tomorrow. */
const missedDelivery: DemoParcel = {
  barcode: "DEMO0000000002",
  order: { number: "DEMO-1001", placedSecondsBefore: 3_600 },
  items: [item("Desk lamp", 1, 39.0, "Lamp")],
  weightKg: 2.4,
  steps: [
    { id: "1", at: 0, status: "registered", text: "Shipment data received", place: null },
    // City only: no coordinates, so the map skips it.
    { id: "2", at: 45, status: "in_transit", text: "Picked up", place: "Hamburg" },
    {
      id: "3",
      at: 180,
      status: "in_transit",
      text: "Arrived at the delivery depot",
      place: "Berlin",
      point: PLACES.berlinDepot,
    },
    { id: "4", at: 320, status: "out_for_delivery", text: "Out for delivery", place: "Berlin" },
    {
      id: "5",
      at: 530,
      status: "problem",
      text: "Delivery attempt failed: recipient not at home",
      place: "Berlin",
      point: PLACES.alexanderplatz,
    },
    {
      id: "6",
      at: 560,
      status: "at_pickup_point",
      text: "Taken to a parcel shop, ready for collection from tomorrow 10:00",
      place: "Demo parcel shop, Alexanderplatz",
      point: PLACES.parcelShop,
    },
  ],
  drive: { from: 320, to: 525, route: stopsBetween(PLACES.berlinDepot, PLACES.alexanderplatz) },
  pickup: { name: "Demo parcel shop, Alexanderplatz 1", at: 560, nextDay: true },
};

/** Straight to a parcel locker; one scan uses wording no rule maps. */
const toTheLocker: DemoParcel = {
  barcode: "DEMO0000000003",
  order: { number: "DEMO-1002", placedSecondsBefore: 1_800 },
  items: [item("Paperback novel", 1, 14.99, "Book")],
  weightKg: 0.4,
  steps: [
    { id: "1", at: 0, status: "registered", text: "Shipment data received", place: null },
    {
      id: "2",
      at: 120,
      status: "in_transit",
      text: "Picked up",
      place: "Cologne",
      point: PLACES.cologne,
    },
    // Deliberately without a mapped status: shows how unknown wording looks.
    { id: "3", at: 300, status: null, text: "Sorted for onward transport", place: "Kassel" },
    {
      id: "4",
      at: 420,
      status: "in_transit",
      text: "Arrived in the destination area",
      place: "Berlin",
    },
    {
      id: "5",
      at: 520,
      status: "at_pickup_point",
      text: "Ready for collection at the parcel locker",
      place: "Demo parcel locker 42",
      point: PLACES.locker,
    },
  ],
  drive: null,
  pickup: { name: "Demo parcel locker 42, Alexanderplatz", at: 520, nextDay: false },
};

export const DEMO_PARCELS: readonly DemoParcel[] = [toTheDoor, missedDelivery, toTheLocker];

/** The run `now` falls in: its start and how far into it we are, in seconds. */
export function runOf(now: number): { readonly start: number; readonly second: number } {
  const start = now - (now % LOOP_MS);
  return { start, second: (now - start) / 1000 };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

/** Ten o'clock (UTC) the day after `ms`, when the missed parcel can be collected. */
function tomorrowAtTen(ms: number): number {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, 10);
}

/** The parcel as the courier sees it at `now`: only what has happened so far in this run. */
export function courierView(
  parcel: DemoParcel,
  now: number,
): Omit<ParcelSnapshot, "carrier" | "items" | "order" | "handoff" | "raw"> {
  const { start, second } = runOf(now);
  const happened = parcel.steps.filter((step) => step.at <= second);
  const latest = happened.at(-1) ?? parcel.steps[0];
  const mapped = [...happened].reverse().find((step) => step.status !== null) ?? latest;
  const status = mapped?.status ?? "registered";
  const delivered = status === "delivered";
  const driving = parcel.drive !== null && second >= parcel.drive.from && second < parcel.drive.to;
  const pickedUpLater = parcel.pickup !== null && second >= parcel.pickup.at;
  const pickupOpens =
    parcel.pickup === null
      ? null
      : parcel.pickup.nextDay
        ? tomorrowAtTen(start + parcel.pickup.at * 1000)
        : start + parcel.pickup.at * 1000;
  return {
    barcode: parcel.barcode,
    direction: "incoming",
    status,
    rawStatus: latest?.text ?? null,
    delivered,
    deliveredAt: delivered && mapped !== undefined ? iso(start + mapped.at * 1000) : null,
    // Today's delivery window, or the days it can be collected once it waits somewhere.
    plannedFrom: pickedUpLater && pickupOpens !== null ? iso(pickupOpens) : iso(start + 300_000),
    plannedTo:
      pickedUpLater && pickupOpens !== null ? iso(pickupOpens + 7 * DAY) : iso(start + 540_000),
    pickup: pickedUpLater,
    pickupPoint: pickedUpLater ? parcel.pickup.name : null,
    url: null,
    sender: DEMO_SHOP_NAME,
    receiver: "Erika Musterfrau",
    weightKg: parcel.weightKg,
    externalRef: null,
    live: driving ? { ref: { barcode: parcel.barcode }, mapShown: true } : null,
    // Each run starts over: earlier runs' entries are dropped, so the history stays one run long.
    historyComplete: true,
    history: happened.map((step) => ({
      // The run's start in the id: a new run never reuses an old run's entries.
      id: `demo:${String(start)}:${step.id}`,
      at: iso(start + step.at * 1000),
      status: step.status,
      rawStatus: step.text,
      location: step.place,
      ...(step.point === undefined ? {} : { latitude: step.point[0], longitude: step.point[1] }),
    })),
  };
}

/** Where a parcel's courier is at `now`, ten stops counting down to the door; null off the road. */
export function demoLiveReading(barcode: string, now: number): LiveReading | null {
  const drive = DEMO_PARCELS.find((parcel) => parcel.barcode === barcode)?.drive;
  if (drive === undefined || drive === null) return null;
  const { second } = runOf(now);
  if (second < drive.from) return null;
  if (second >= drive.to) {
    return {
      state: "ended",
      stopsAway: null,
      latitude: null,
      longitude: null,
      accuracy: null,
      positionAt: null,
      message: null,
    };
  }
  const progress = (second - drive.from) / (drive.to - drive.from);
  const exact = progress * (drive.route.length - 1);
  const index = Math.floor(exact);
  const from = drive.route[index] ?? drive.route[0];
  const to = drive.route[index + 1] ?? from;
  const share = exact - index;
  const stopsAway = drive.route.length - 1 - index;
  const latitude = (from?.[0] ?? 0) + ((to?.[0] ?? 0) - (from?.[0] ?? 0)) * share;
  const longitude = (from?.[1] ?? 0) + ((to?.[1] ?? 0) - (from?.[1] ?? 0)) * share;
  return {
    state: stopsAway <= 1 ? "next_stop" : "en_route",
    stopsAway,
    latitude,
    longitude,
    accuracy: 15,
    positionAt: iso(now),
    message: stopsAway <= 1 ? "You are next" : `${String(stopsAway)} stops away`,
  };
}
