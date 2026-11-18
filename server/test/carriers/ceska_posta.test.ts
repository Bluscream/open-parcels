import { describe, expect, it } from "vitest";
import { ceskaPosta } from "../../src/carriers/ceska_posta/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onFragment, World } from "./harness.js";

// Made-up codes and values only.
const A = "DR0000000001X";
const B = "DR0000000002X";

const state = (id: string, date: string, text = `Step ${id}`) => ({ id, date, text });
const history = (...states: ReturnType<typeof state>[]) => ({
  attributes: { weight: 1.5 },
  states: { state: states },
});

describe("Česká pošta tracking", () => {
  it("ranks events, reads the delivery day and merges the Balíkovna details", async () => {
    const world = new World(ceskaPosta);
    world.routes = [
      onFragment(
        "getDataAsJson",
        json([
          history(state("-L", "2026-11-16"), state("51", "2026-11-17"), state("53", "2026-11-18")),
          history(state("-3", "2026-11-18")),
        ]),
      ),
      onFragment(
        `/package/${A}`,
        json({
          sender: "Example Shop",
          packageStates: [{ stateId: "53", date: "2026-11-18", time: "07:45" }],
        }),
      ),
    ];
    const result = await world.track([A, B], {}, null);
    expect(world.calls[0]?.url.searchParams.get("idParcel")).toBe(`${A};${B}`);
    // B is the not-found sentinel and is never looked up on Balíkovna.
    expect(world.calls).toHaveLength(2);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      status: "out_for_delivery",
      rawStatus: "Step 53",
      sender: "Example Shop",
      weightKg: 1.5,
      plannedFrom: "2026-11-17T23:00:00.000Z",
      plannedTo: "2026-11-18T22:59:59.000Z",
    });
    expect(result.snapshots[0]?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T06:45:00.000Z", "out_for_delivery"],
      ["2026-11-16T23:00:00.000Z", "in_transit"],
      ["2026-11-15T23:00:00.000Z", "registered"],
    ]);
  });

  it("keeps delivered when a designation record follows it and reports unknown codes", async () => {
    const world = new World(ceskaPosta);
    world.routes = [
      onFragment(
        "getDataAsJson",
        json([
          history(
            state("91", "2026-11-18"),
            state("BG1", "2026-11-18", ""),
            state("ZZ", "2026-11-18"),
          ),
        ]),
      ),
      onFragment("/package/", json({}, 500)),
    ];
    const [parcel] = (await world.track([A], {}, null)).snapshots;
    expect(parcel).toMatchObject({ status: "delivered", delivered: true });
    expect(world.unknown).toEqual(["status_code:ZZ"]);
  });

  it("fails the run when the history service fails", async () => {
    const world = new World(ceskaPosta);
    world.routes = [onFragment("getDataAsJson", json({}, 503))];
    await expect(world.track([A], {}, null)).rejects.toBeInstanceOf(TransientError);
  });
});
