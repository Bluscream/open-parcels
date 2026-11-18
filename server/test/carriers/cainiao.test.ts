import { describe, expect, it } from "vitest";
import { cainiao } from "../../src/carriers/cainiao/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./kit-harness.js";

// Made-up codes and values only.
const A = "TESTCN0000001";
const B = "TESTCN0000002";

function entry(code: string, action: string) {
  return {
    mailNo: code,
    statusDesc: "Latest step",
    latestTrace: { actionCode: action, time: 1_795_000_000_000, standerdDesc: "Latest step" },
    globalEtaInfo: { deliveryMinTime: 1_795_100_000_000, deliveryMaxTime: 1_795_200_000_000 },
    detailList: [
      { actionCode: action, time: 1_795_000_000_000, standerdDesc: "Latest step" },
      { actionCode: "LH_DEPART", time: 1_794_900_000_000, desc: "Departed" },
    ],
  };
}

describe("Cainiao tracking", () => {
  it("batches codes and reads status, window and history", async () => {
    const world = new World(cainiao);
    world.routes = [
      on(
        "/global/detail.json",
        json({
          success: true,
          module: [entry(A, "GTMS_DO_DEPART"), { mailNo: B, detailList: [] }],
        }),
      ),
    ];
    const result = await world.track([A, B], {}, null);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]?.url.searchParams.get("mailNos")).toBe(`${A},${B}`);
    // B has no events yet: not found.
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      barcode: A,
      status: "out_for_delivery",
      rawStatus: "Latest step",
      plannedFrom: new Date(1_795_100_000_000).toISOString(),
      plannedTo: new Date(1_795_200_000_000).toISOString(),
    });
    expect(result.snapshots[0]?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
    ]);
  });

  it("reports an unmapped action code", async () => {
    const world = new World(cainiao);
    world.routes = [
      on("/global/detail.json", json({ success: true, module: [entry(A, "NEW_THING")] })),
    ];
    const [parcel] = (await world.track([A], {}, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:NEW_THING"]);
  });

  it("stops on an unsuccessful envelope", async () => {
    const world = new World(cainiao);
    world.routes = [on("/global/detail.json", json({ success: false, module: [] }))];
    await expect(world.track([A], {}, null)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
