import { describe, expect, it } from "vitest";
import { postnord } from "../../src/carriers/postnord/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onPrefix, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "00370000000000000001";
const OTHER = "00370000000000000002";
const API = "GET api2.postnord.com/rest/shipment/v5/trackandtrace/recipientview";

const event = (status: string, at: string, code = "10", extra: Record<string, unknown> = {}) => ({
  status,
  eventCode: code,
  eventTime: at,
  eventDescription: `Hændelse ${code}`,
  location: { displayName: "Testby" },
  ...extra,
});

function shipment(status: string, events: unknown[], extra: Record<string, unknown> = {}) {
  return json({
    TrackingInformationResponse: {
      shipments: [
        {
          shipmentId: CODE,
          status,
          statusText: { header: "Overskrift" },
          consignor: { name: "Testbutik" },
          consignee: { name: "T. Person" },
          totalWeight: { value: "750", unit: "g" },
          estimatedTimeOfArrival: "2026-11-19T12:00:00",
          items: [{ events }],
          ...extra,
        },
      ],
    },
  });
}

describe("PostNord tracking", () => {
  it("maps the shipment, honours the out-for-delivery event and keeps the history", async () => {
    const world = new World(postnord, [
      onPrefix(
        API,
        shipment("EN_ROUTE", [
          event("INFORMED", "2026-11-16T09:00:00"),
          event("EN_ROUTE", "2026-11-17T09:00:00"),
          event("OTHER", "2026-11-17T12:00:00", "99"),
          event("EN_ROUTE", "2026-11-18T08:00:00", "113"),
        ]),
      ),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "postnord",
      status: "out_for_delivery",
      rawStatus: "Overskrift",
      plannedFrom: "2026-11-19T12:00:00.000Z",
      sender: "Testbutik",
      receiver: "T. Person",
      weightKg: 0.75,
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "in_transit",
      "registered",
    ]);
    expect(world.calls[0]?.headers.get("x-bap-key")).toBe("web-ncp");
  });

  it("reports a finished return as delivered with its time", async () => {
    const world = new World(postnord, [
      onPrefix(
        API,
        shipment("RETURNED", [
          event("RETURNED", "2026-11-17T09:00:00"),
          event("DELIVERED", "2026-11-18T09:00:00"),
        ]),
      ),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats an empty shipment list as not found", async () => {
    const world = new World(postnord, [
      onPrefix(API, json({ TrackingInformationResponse: { shipments: [] } })),
    ]);
    expect((await world.track([CODE, "../x"])).snapshots).toEqual([]);
    expect(world.calls).toHaveLength(1);
  });

  it("files an item id's shipment under the item id, keeping the shipment id as reference", async () => {
    const world = new World(postnord, [
      onPrefix(API, shipment("EN_ROUTE", [], { shipmentId: OTHER })),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({ barcode: CODE, externalRef: OTHER });
  });

  it("reports an unknown shipment status", async () => {
    const world = new World(postnord, [onPrefix(API, shipment("TELEPORTED", []))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:TELEPORTED"]);
  });

  it("stops on a refused web tag and on a network error", async () => {
    const refused = new World(postnord, [onPrefix(API, json({}, 403))]);
    await expect(refused.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(refused.calls).toHaveLength(1);
    const offline = new World(postnord, [onPrefix(API, new TypeError("offline"))]);
    await expect(offline.track([CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
