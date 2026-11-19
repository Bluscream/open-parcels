import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoLiveReading, LOOP_MS } from "../../src/carriers/demo/data.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import { register } from "../../src/engine/registry.js";
import { ParcelRepository } from "../../src/parcels/repository.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* The test clock starts on a run boundary (12:00:00 UTC), so seconds into the run are exact. */

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext({ plugins: [register(demoCarrier), register(demoShop)] });
});
afterEach(async () => {
  await context.close();
});

async function source(plugin: string, kind: "account" | "shop"): Promise<string> {
  return (
    await context.services.sources.create({ plugin, kind, label: plugin, config: {}, secret: null })
  ).id;
}

async function parcels() {
  const all = await new ParcelRepository(context.services.db).list({ includeArchived: true }, true);
  return new Map(all.map((parcel) => [parcel.barcode, parcel]));
}

/** Moves the clock to `second` into the current run and lets the courier report. */
async function at(second: number, courier: string): Promise<void> {
  const into = (context.clock.now().getTime() % LOOP_MS) / 1000;
  context.clock.advance((second - into) * 1000);
  await context.services.runner.run(courier);
}

describe("demo courier and demo shop", () => {
  it("play the story from announced to delivered, missed and collected, then start over", async () => {
    await context.services.runner.run(await source("demo_shop", "shop"));
    const courier = await source("demo", "account");
    await at(5, courier);

    let now = await parcels();
    expect([...now.keys()].sort()).toEqual(["DEMO0000000001", "DEMO0000000002", "DEMO0000000003"]);
    expect(new Set([...now.values()].map((parcel) => parcel.status))).toEqual(
      new Set(["registered"]),
    );
    expect(new Set([...now.values()].map((parcel) => parcel.order?.order_number))).toEqual(
      new Set(["DEMO-1001", "DEMO-1002"]),
    );
    expect(now.get("DEMO0000000001")?.items).toHaveLength(2);

    await at(200, courier);
    now = await parcels();
    expect(now.get("DEMO0000000001")).toMatchObject({ status: "in_transit" });
    expect(now.get("DEMO0000000001")?.location).toMatchObject({ name: "Leipzig hub" });
    // A scan with a city only has no position.
    expect(now.get("DEMO0000000002")?.history.find((e) => e.location === "Hamburg")).toMatchObject({
      latitude: null,
    });

    await at(330, courier);
    now = await parcels();
    expect(now.get("DEMO0000000001")?.status).toBe("out_for_delivery");
    const start = context.clock.now().getTime() - 330_000;
    expect(demoLiveReading("DEMO0000000001", start + 301_000)).toMatchObject({ stopsAway: 10 });
    expect(demoLiveReading("DEMO0000000001", start + 520_000)).toMatchObject({
      state: "next_stop",
    });
    expect(demoLiveReading("DEMO0000000003", start + 330_000)).toBeNull();
    // Where it is now is the courier; the last placed scan stays alongside.
    const driving = now.get("DEMO0000000001");
    // The scheduler hands the live tracker its targets; this test runs the source directly.
    context.services.live.setTargets(courier, [
      {
        parcelId: driving?.id ?? "",
        target: { ref: { barcode: "DEMO0000000001" }, mapShown: true },
      },
    ]);
    await context.services.live.pass();
    const placed = await context.services.parcels.repository.get(driving?.id ?? "");
    expect(placed?.location).toMatchObject({ source: "courier" });
    expect(placed?.last_scan).toMatchObject({ source: "event", name: "Berlin" });

    await at(540, courier);
    now = await parcels();
    expect(now.get("DEMO0000000001")).toMatchObject({ status: "delivered", delivered: true });
    expect(now.get("DEMO0000000002")?.status).toBe("problem");
    expect(now.get("DEMO0000000003")).toMatchObject({ status: "at_pickup_point", pickup: true });

    await at(570, courier);
    const missed = (await parcels()).get("DEMO0000000002");
    expect(missed).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickup_point: "Demo parcel shop, Alexanderplatz 1",
    });
    // Collectable from ten o'clock the next day.
    expect(missed?.planned_from).toBe("2026-11-19T10:00:00.000Z");

    // The next run starts over, with only its own history.
    context.clock.advance(LOOP_MS - 570_000 + 10_000);
    await context.services.runner.run(courier);
    const again = (await parcels()).get("DEMO0000000001");
    expect(again).toMatchObject({ status: "registered", delivered: false });
    // Last run's pickup point does not carry over into the new one.
    expect((await parcels()).get("DEMO0000000002")).toMatchObject({
      pickup: false,
      pickup_point: null,
    });
    expect(again?.history).toHaveLength(1);
  });
});
