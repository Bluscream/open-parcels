import { describe, expect, it } from "vitest";
import { canpar } from "../../src/carriers/canpar/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, onFragment, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "TESTCP000000001";

function parcel(code: string, events: { code: string; at: string }[], extra = {}) {
  return {
    barcode: code,
    delivered: false,
    estimated_delivery_date: "20261119",
    events: events.map((e) => ({
      code: e.code,
      code_description_en: `Step ${e.code}`,
      local_date_time: e.at,
      address: { name: "Test Person", city: "Testville", province: "ON" },
    })),
    ...extra,
  };
}

describe("Canpar tracking", () => {
  it("reads status, the day window in Eastern time and history", async () => {
    const world = new World(canpar);
    world.routes = [
      onFragment(
        "trackByBarcodeV2",
        json({
          error: null,
          result: [
            parcel(CODE, [
              { code: "WC", at: "20261118 080000" },
              { code: "ARR", at: "20261117 200000" },
            ]),
          ],
        }),
      ),
    ];
    const [snap] = (await world.track([CODE], {}, null)).snapshots;
    expect(snap).toMatchObject({
      carrier: "canpar",
      status: "out_for_delivery",
      rawStatus: "Step WC",
      plannedFrom: "2026-11-19T05:00:00.000Z",
      plannedTo: "2026-11-20T04:59:59.000Z",
    });
    expect(snap?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T13:00:00.000Z", "out_for_delivery"],
      ["2026-11-18T01:00:00.000Z", "in_transit"],
    ]);
    // Addresses never reach the stored payload.
    expect(JSON.stringify(snap?.raw)).not.toContain("Test Person");
    expect(new Headers(world.calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  it("returns nothing for an empty result", async () => {
    const world = new World(canpar);
    world.routes = [onFragment("trackByBarcodeV2", json({ error: null, result: [] }))];
    expect((await world.track([CODE, "x"], {}, null)).snapshots).toEqual([]);
    expect(world.calls).toHaveLength(1);
  });

  it("reports an unmapped event code", async () => {
    const world = new World(canpar);
    world.routes = [
      onFragment(
        "trackByBarcodeV2",
        json({ result: [parcel(CODE, [{ code: "ZZZ", at: "20261118 080000" }])] }),
      ),
    ];
    const [snap] = (await world.track([CODE], {}, null)).snapshots;
    expect(snap?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:ZZZ"]);
  });

  it("stops on an error envelope or a 5xx", async () => {
    const world = new World(canpar);
    world.routes = [onFragment("trackByBarcodeV2", json({ error: "bad" }))];
    await expect(world.track([CODE], {}, null)).rejects.toBeInstanceOf(UnexpectedResponseError);
    world.routes = [onFragment("trackByBarcodeV2", json({}, 500))];
    await expect(world.track([CODE], {}, null)).rejects.toBeInstanceOf(TransientError);
  });
});
