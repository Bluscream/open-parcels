import { describe, expect, it } from "vitest";
import { appleExpress } from "../../src/carriers/apple-express/index.js";
import { InvalidSourceConfigError } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, world } from "./harness.js";

// Made-up codes and values only.
const CODE = "AE000000001";
const ROUTE = `GET trackapi.appleexpress.com/api/track/order/${CODE}/language/en`;

const step = (status: string, generatedAt: string, override: string | null = null) => ({
  status,
  generatedAt,
  statusDescriptionOverride: override,
});

function found(currentStatus: string, statusChangeText: string) {
  return {
    orderDetails: { appleTrackingNumber: CODE, currentStatus, statusChangeText },
    statusDetails: [
      step(currentStatus, "2026-11-18T09:00:00"),
      step("Received at Local Sort Facility", "2026-11-17T22:15:00"),
      step("Order Created", "2026-11-16T10:00:00"),
    ],
    customerDetails: null,
  };
}

describe("Apple Express tracking", () => {
  it("reads status, Eastern-time history and the six-hour window", async () => {
    const w = world(appleExpress);
    w.routes = [
      on(ROUTE, json(found("Out for Delivery", "Estimated Delivery: November 18, 2026 02:00 PM"))),
    ];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "apple-express",
      barcode: CODE,
      status: "out_for_delivery",
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T19:00:00.000Z",
      url: `https://track.appleexpress.com/en-US/orderNumber/${CODE}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T14:00:00.000Z", "out_for_delivery"],
      ["2026-11-18T03:15:00.000Z", "in_transit"],
      ["2026-11-16T15:00:00.000Z", "registered"],
    ]);
  });

  it("reads the delivery time from the display sentence and honours a zone option", async () => {
    const w = world(appleExpress);
    w.routes = [on(ROUTE, json(found("Delivered", "Delivered November 18, 2026 01:30 PM")))];
    const [parcel] = (await w.track([CODE], { timeZone: "America/Regina" })).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T19:30:00.000Z",
      plannedFrom: null,
      plannedTo: null,
    });
  });

  it("treats the all-null answer as not found", async () => {
    const w = world(appleExpress);
    w.routes = [
      on(ROUTE, json({ orderDetails: null, statusDetails: null, customerDetails: null })),
    ];
    expect((await w.track([CODE])).snapshots).toEqual([]);
  });

  it("reports an unmapped status", async () => {
    const w = world(appleExpress);
    w.routes = [on(ROUTE, json(found("Held at Depot", "")))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_text:Held at Depot"]);
  });

  it("stops on a half answer, passes network errors on and rejects a bad zone", async () => {
    const half = world(appleExpress);
    half.routes = [on(ROUTE, json({ orderDetails: {}, statusDetails: "x" }))];
    await expect(half.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);

    const offline = world(appleExpress);
    offline.routes = [on(ROUTE, new Error("offline"))];
    await expect(offline.track([CODE])).rejects.toBeInstanceOf(TransientError);

    await expect(
      world(appleExpress).track([CODE], { timeZone: "Mars/Base" }),
    ).rejects.toBeInstanceOf(InvalidSourceConfigError);
  });
});
