import { describe, expect, it } from "vitest";
import { budbee } from "../../src/carriers/budbee/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onFragment, World } from "./harness.js";

// Made-up codes and values only.
const meta = (type: string) => ({ status: "SUCCESS", payload: { type, brand: "BUDBEE" } });

describe("Budbee tracking", () => {
  it("reads a door delivery with status and window", async () => {
    const world = new World(budbee);
    world.routes = [
      onFragment("/v3/orders/TESTBB01/meta", json(meta("DELIVERY"))),
      onFragment(
        "/v3/orders/TESTBB01",
        json({
          payload: {
            conspectus: {
              token: "TESTBB01",
              status: { state: "OnRouteDelivery", date: "2026-11-18T08:00:00Z" },
              consignment: {
                type: "DELIVERY",
                start: "2026-11-18T16:00:00Z",
                stop: "2026-11-18T18:00:00Z",
              },
              merchant: { name: "Beispielshop" },
              consumer: { name: "*****" },
            },
          },
        }),
      ),
    ];
    const [parcel] = (await world.track(["TESTBB01"], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "budbee",
      status: "out_for_delivery",
      plannedFrom: "2026-11-18T16:00:00.000Z",
      plannedTo: "2026-11-18T18:00:00.000Z",
      sender: "Beispielshop",
      receiver: null,
      history: [],
    });
  });

  it("treats Delivered on a locker order as waiting in the locker", async () => {
    const world = new World(budbee);
    world.routes = [
      onFragment("/meta", json(meta("BOX"))),
      onFragment(
        "/box/TESTBB02",
        json({
          token: "TESTBB02",
          status: "Delivered",
          eta: "2026-11-18T10:00:00Z",
          lockerAddress: { name: "Testlocker" },
        }),
      ),
    ];
    const [parcel] = (await world.track(["TESTBB02"], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      delivered: false,
      pickupPoint: "Testlocker",
      plannedTo: "2026-11-18T10:00:00.000Z",
    });
  });

  it("returns nothing for an unknown code", async () => {
    const world = new World(budbee);
    world.routes = [onFragment("/meta", json({ status: "FAILED", errorCode: "ORDER_NOT_FOUND" }))];
    const result = await world.track(["TESTBB03", "../x"], {}, null);
    expect(result.snapshots).toEqual([]);
    expect(world.calls).toHaveLength(1);
  });

  it("reports an unmapped status", async () => {
    const world = new World(budbee);
    world.routes = [
      onFragment("/meta", json(meta("BOX"))),
      onFragment("/box/TESTBB04", json({ token: "TESTBB04", status: "Teleported" })),
    ];
    const [parcel] = (await world.track(["TESTBB04"], {}, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:BOX:Teleported"]);
  });

  it("fails the run on a 5xx", async () => {
    const world = new World(budbee);
    world.routes = [onFragment("/meta", json({}, 502))];
    await expect(world.track(["TESTBB05"], {}, null)).rejects.toBeInstanceOf(TransientError);
  });
});
