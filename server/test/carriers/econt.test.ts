import { describe, expect, it } from "vitest";
import { econt } from "../../src/carriers/econt/index.js";
import { register } from "../../src/engine/registry.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness.js";

// Made-up shipment numbers and values only.
const ACTIVE = "9900000000001";
const MISSING = "9900000000002";
const ROUTE = "POST ee.econt.com/services/Shipments/ShipmentService.getShipmentStatuses.json";
const plugin = register(econt);

function shipment(number: string, extra: Record<string, unknown> = {}) {
  return {
    shipmentNumber: number,
    shortDeliveryStatusEn: "In delivery office",
    expectedDeliveryDate: "2026-11-20",
    weight: 1.25,
    trackingEvents: [
      { time: 1_763_366_400_000, destinationType: "prepared", destinationDetailsEn: "Prepared" },
      {
        time: 1_763_452_800_000,
        destinationType: "in_delivery_office",
        destinationDetailsEn: "Office",
      },
    ],
    ...extra,
  };
}

describe("Econt tracking", () => {
  it("looks codes up in one batch and reads status, day window, weight and history", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: { shipmentStatuses: [{ status: shipment(ACTIVE) }, { error: { message: "x" } }] },
        },
      ],
    });
    const { base, unknown } = harness(econt.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE, MISSING]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ shipmentNumbers: [ACTIVE, MISSING] });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "econt",
      barcode: ACTIVE,
      status: "in_transit",
      plannedFrom: "2026-11-19T22:00:00.000Z",
      plannedTo: "2026-11-20T21:59:59.000Z",
      weightKg: 1.25,
    });
    expect(result.snapshots[0]?.history.map((event) => event.status)).toEqual([
      "in_transit",
      "registered",
    ]);
    expect(unknown).toEqual([]);
  });

  it("counts a delivery time as delivered", async () => {
    const delivered = shipment(ACTIVE, {
      shortDeliveryStatusEn: "Something",
      deliveryTime: "2026-11-18T10:00:00+02:00",
    });
    const { fetchImpl } = scripted({
      [ROUTE]: [{ status: 200, body: { shipmentStatuses: [{ status: delivered }] } }],
    });
    const { base } = harness(econt.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [ACTIVE])).snapshots;
    expect(found).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T08:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("reports an unknown status and stops on an answer for another code", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: {
            shipmentStatuses: [{ status: shipment(ACTIVE, { shortDeliveryStatusEn: "Odd" }) }],
          },
        },
        { status: 200, body: { shipmentStatuses: [{ status: shipment(MISSING) }] } },
      ],
    });
    const { base, unknown } = harness(econt.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [ACTIVE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status:Odd"]);
    await expect(plugin.track(base, {}, null, [ACTIVE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
