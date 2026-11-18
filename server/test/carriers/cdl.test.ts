import { describe, expect, it } from "vitest";
import { cdl } from "../../src/carriers/cdl/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onFragment, World } from "./harness.js";

// Made-up codes and values only.
const LABEL = "CDL00000000001";
const ORDER = "0000000001";

function answer(reference: string, events: [string, string][]) {
  return {
    trackingInformation: { referenceNumber: reference },
    trackingEvents: events.map(([trackingEvent, trackingEventTimestamp]) => ({
      trackingEvent,
      trackingEventTimestamp,
      photo: "made-up-photo-data",
    })),
  };
}

describe("CDL Last Mile tracking", () => {
  it("reads status and history, and sends an order number with its hyphen", async () => {
    const world = new World(cdl);
    world.routes = [
      onFragment(
        "value=000000000-1",
        json(
          answer("000000000-1", [
            ["CDL Origin Scan", "2026-11-17T09:00:00"],
            ["Package Out for Delivery", "2026-11-18T07:30:00"],
          ]),
        ),
      ),
    ];
    const [parcel] = (await world.track([ORDER], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "cdl",
      barcode: ORDER,
      status: "out_for_delivery",
      rawStatus: "Package Out for Delivery",
      plannedFrom: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T12:30:00.000Z", "out_for_delivery"],
      ["2026-11-17T14:00:00.000Z", "in_transit"],
    ]);
    expect(JSON.stringify(parcel?.raw)).not.toContain("photo");
  });

  it("treats a completion as delivered even when the door scan reads later", async () => {
    const world = new World(cdl);
    world.routes = [
      onFragment(
        LABEL,
        json(
          answer(LABEL, [
            ["Delivery complete", "2026-11-18T10:15:00"],
            ["Delivery complete", "2026-11-18T10:15:00"],
            ["Package Scanned at Delivery", "2026-11-18T10:15:42"],
          ]),
        ),
      ),
    ];
    const [parcel] = (await world.track([LABEL], {}, null)).snapshots;
    expect(parcel).toMatchObject({ status: "delivered", delivered: true });
    expect(parcel?.history).toHaveLength(2);
  });

  it("returns nothing for 204, another reference or a code of the wrong shape", async () => {
    const world = new World(cdl);
    world.routes = [
      onFragment(LABEL, new Response(null, { status: 204 })),
      onFragment("000000000-1", json(answer("OTHER", []))),
    ];
    expect((await world.track([LABEL, ORDER, "SHIPPERREF"], {}, null)).snapshots).toEqual([]);
    expect(world.calls).toHaveLength(2);
  });

  it("reports an unmapped wording", async () => {
    const world = new World(cdl);
    world.routes = [
      onFragment(LABEL, json(answer(LABEL, [["Teleported", "2026-11-18T10:00:00"]]))),
    ];
    const [parcel] = (await world.track([LABEL], {}, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:teleported"]);
  });

  it("fails on a redirect", async () => {
    const world = new World(cdl);
    world.routes = [
      onFragment(LABEL, new Response(null, { status: 302, headers: { location: "/x" } })),
    ];
    await expect(world.track([LABEL], {}, null)).rejects.toBeInstanceOf(TransientError);
  });
});
