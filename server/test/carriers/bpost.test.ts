import { describe, expect, it } from "vitest";
import { bpost } from "../../src/carriers/bpost/index.js";
import { InvalidSourceConfigError } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, on, World } from "./harness.js";

// Made-up codes, postcodes and names only.
const CODE = "323200000000000001";
const config = { postalCode: "0000" };
const ROUTE = "GET track.bpost.cloud/track/items";

const event = (date: string, time: string, en: string, nl: string) => ({
  date,
  time,
  key: { EN: { description: en }, NL: { description: nl } },
});

function item(step: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    items: [
      {
        itemCode: CODE,
        activeStep: step,
        senderCommercialName: "Example Shop",
        receiver: { name: "Test Person" },
        weightInGrams: 1250,
        expectedDeliveryTimeRange: { day: "2026-11-19", time1: "10:00", time2: "13:00" },
        events: [
          event("2026-11-18", "07:10", "Out for delivery", "Onderweg"),
          event("2026-11-17", "22:05", "Sorted", "Gesorteerd"),
        ],
        ...extra,
      },
    ],
  };
}

describe("bpost tracking", () => {
  it("maps the process step and reads window, history, weight in Brussels time", async () => {
    const w = new World(bpost);
    w.routes = [on(ROUTE, json(item({ knownProcessStep: "OUT_FOR_DELIVERY_HOME", name: "x" })))];
    const [parcel] = (await w.track([CODE], config)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "bpost",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "OUT_FOR_DELIVERY_HOME",
      delivered: false,
      plannedFrom: "2026-11-19T09:00:00.000Z",
      plannedTo: "2026-11-19T12:00:00.000Z",
      sender: "Example Shop",
      weightKg: 1.25,
      pickup: false,
    });
    expect(parcel?.history.map((e) => [e.at, e.rawStatus])).toEqual([
      ["2026-11-18T06:10:00.000Z", "Out for delivery"],
      ["2026-11-17T21:05:00.000Z", "Sorted"],
    ]);
    expect(parcel?.url).toContain(`itemCode=${CODE}`);
    const sent = w.calls[0]?.url.searchParams;
    expect([sent?.get("itemIdentifier"), sent?.get("postalCode")]).toEqual([CODE, "0000"]);
  });

  it("takes delivery from the delivery record and names a pickup point", async () => {
    const w = new World(bpost);
    const delivered = item(
      { name: "delivered_some_new_method" },
      {
        actualDeliveryInformation: { actualDeliveryTime: { day: "2026-11-18", time: "13:06" } },
        deliveryPoint: { type: "PARCEL_LOCKER", name: "Locker Testtown" },
      },
    );
    w.routes = [on(ROUTE, json(delivered))];
    const [parcel] = (await w.track([CODE], { ...config, language: "nl" })).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T12:06:00.000Z",
      plannedFrom: null,
      pickup: true,
      pickupPoint: "Locker Testtown",
    });
    expect(parcel?.history[0]?.rawStatus).toBe("Onderweg");
    // Matched by its known prefix, still reported so the table can grow.
    expect(w.unknown).toEqual(["status_code:activeStep:delivered_some_new_method"]);
  });

  it("treats an error answer or no items as not found", async () => {
    const w = new World(bpost);
    w.routes = [on(ROUTE, json({ error: "NO_DATA_FOUND" }), json({ items: [] }))];
    expect((await w.track([CODE], config)).snapshots).toEqual([]);
    expect((await w.track([CODE], config)).snapshots).toEqual([]);
  });

  it("reports a step code outside the vocabulary", async () => {
    const w = new World(bpost);
    w.routes = [on(ROUTE, json(item({ knownProcessStep: "TELEPORTING" })))];
    const [parcel] = (await w.track([CODE], config)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_code:knownProcessStep:TELEPORTING"]);
  });

  it("needs a postcode and passes network errors on", async () => {
    await expect(new World(bpost).track([CODE], {})).rejects.toBeInstanceOf(
      InvalidSourceConfigError,
    );
    const offline = new World(bpost);
    offline.routes = [on(ROUTE, new Error("offline"))];
    await expect(offline.track([CODE], config)).rejects.toBeInstanceOf(TransientError);
  });
});
