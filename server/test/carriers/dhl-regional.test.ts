import { describe, expect, it } from "vitest";
import { dhl } from "../../src/carriers/dhl/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { html, json, on, World, type Route } from "./kit-harness.js";

// Made-up codes and values only.
const IBERIA = "0000000000000001";
const SWEDEN = "SE00000001";

/** The gateway knows none of these codes. */
const gatewayMiss: Route = on("/track-trace", json({}, 404));

function iberiaShipment(code: string, events: Record<string, unknown>[]) {
  return {
    ExpeditionNumber: code,
    Weight: "1,25",
    ServicePoint: { Name: "Test ServicePoint" },
    Tracking: events,
  };
}

describe("DHL regional back ends", () => {
  it("does not ask regional back ends unless the source turns them on", async () => {
    const world = new World(dhl);
    world.routes = [gatewayMiss];
    expect((await world.track([IBERIA, SWEDEN], {}, null)).snapshots).toEqual([]);
    expect(world.paths().every((p) => p.includes("dhlparcel.nl"))).toBe(true);
  });

  it("reads a DHL Iberia shipment with status, pickup point and history", async () => {
    const world = new World(dhl);
    world.routes = [
      gatewayMiss,
      on(
        "shipment-detail",
        json(
          iberiaShipment(IBERIA, [
            {
              Code: "IS",
              Description: "Available at ServicePoint",
              Date: "18/11/2026",
              Time: "10:30",
            },
            {
              Code: null,
              Description: "Arrived at",
              Town: "Testciudad",
              Date: "17/11/2026",
              Time: "08:00",
            },
          ]),
        ),
      ),
    ];
    const [parcel] = (await world.track([IBERIA], { regions: ["ES"] }, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "dhl",
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Test ServicePoint",
      weightKg: 1.25,
    });
    expect(parcel?.history.map((e) => [e.at, e.rawStatus])).toEqual([
      ["2026-11-17T07:00:00.000Z", "Arrived at Testciudad"],
      ["2026-11-18T09:30:00.000Z", "Available at ServicePoint"],
    ]);
  });

  it("treats an Iberia 204 as not found, reports unknown codes and stops on a challenge page", async () => {
    const world = new World(dhl);
    world.routes = [gatewayMiss, on("shipment-detail", new Response(null, { status: 204 }))];
    expect((await world.track([IBERIA], { regions: ["PT"] }, null)).snapshots).toEqual([]);

    world.routes = [
      gatewayMiss,
      on(
        "shipment-detail",
        json(iberiaShipment(IBERIA, [{ Code: "QQ", Date: "18/11/2026", Time: "10:30" }])),
      ),
    ];
    const [parcel] = (await world.track([IBERIA], { regions: ["ES"] }, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toContain("status_code:iberia:QQ");

    world.routes = [gatewayMiss, on("shipment-detail", html("<html>challenge</html>"))];
    await expect(world.track([IBERIA], { regions: ["ES"] }, null)).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it("reads DHL Freight Sweden shipments in one request", async () => {
    const world = new World(dhl);
    world.routes = [
      gatewayMiss,
      on(
        "/api/v1/shipment",
        json([
          {
            trackingNumber: SWEDEN,
            deliveryMethod: "HOME_DELIVERY",
            isCollected: true,
            parties: [{ type: "CZ", name: "Example Shop" }],
            events: [
              {
                statusCode: 21,
                reasonCode: 0,
                eventText: "Delivered",
                occuredAtTime: "2026-11-18T09:00:00Z",
              },
              {
                statusCode: 24,
                reasonCode: 501,
                eventText: "Out",
                occuredAtTime: "2026-11-18T06:00:00Z",
              },
            ],
          },
        ]),
      ),
    ];
    const [parcel] = (await world.track([SWEDEN], { regions: ["SE"] }, null)).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      sender: "Example Shop",
      pickup: false,
    });
    expect(
      world.calls.find((c) => c.url.hostname === "hamta.dhl.com")?.url.searchParams.getAll("ids"),
    ).toEqual([SWEDEN]);
  });

  it("reports an unmapped Freight Sweden event and keeps the parcel in transit", async () => {
    const world = new World(dhl);
    world.routes = [
      gatewayMiss,
      on(
        "/api/v1/shipment",
        json([
          {
            trackingNumber: SWEDEN,
            events: [
              {
                statusCode: 77,
                reasonCode: 1,
                eventText: "New",
                occuredAtTime: "2026-11-18T06:00:00Z",
              },
            ],
          },
        ]),
      ),
    ];
    const [parcel] = (await world.track([SWEDEN], { regions: ["SE"] }, null)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(world.unknown).toContain("status_code:sweden:77/1");
  });
});
