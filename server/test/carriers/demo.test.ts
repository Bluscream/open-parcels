import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoLiveReading } from "../../src/carriers/demo/data.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import { register } from "../../src/engine/registry.js";
import { ParcelRepository } from "../../src/parcels/repository.js";
import { createTestContext, type TestContext } from "../helpers.js";

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

describe("demo courier and demo shop", () => {
  it("give three parcels in two orders, with items, places and a live courier", async () => {
    await context.services.runner.run(await source("demo_shop", "shop"));
    const courier = await source("demo", "account");
    await context.services.runner.run(courier);
    // A second run adds nothing: every demo entry has a fixed id.
    await context.services.runner.run(courier);

    const parcels = await new ParcelRepository(context.services.db).list(
      { includeArchived: true },
      true,
    );
    expect(parcels.map((parcel) => parcel.barcode).sort()).toEqual([
      "DEMO0000000001",
      "DEMO0000000002",
      "DEMO0000000003",
    ]);
    expect(new Set(parcels.map((parcel) => parcel.carrier))).toEqual(new Set(["demo"]));
    expect(new Set(parcels.map((parcel) => parcel.order?.order_number))).toEqual(
      new Set(["DEMO-1001", "DEMO-1002"]),
    );

    const delivered = parcels.find((parcel) => parcel.barcode === "DEMO0000000001");
    expect(delivered?.delivered).toBe(true);
    expect(delivered?.items).toHaveLength(2);
    expect(delivered?.history).toHaveLength(5);
    expect(delivered?.location).toMatchObject({ source: "event", name: "Berlin-Mitte" });

    const cityOnly = parcels.find((parcel) => parcel.barcode === "DEMO0000000002");
    expect(cityOnly?.history.every((entry) => entry.latitude === null)).toBe(true);
    expect(cityOnly?.location).toBeNull();

    const pickup = parcels.find((parcel) => parcel.barcode === "DEMO0000000003");
    expect(pickup?.pickup).toBe(true);
    expect(pickup?.history.some((entry) => entry.status === null)).toBe(true);
    // The latest scan has no position, so the place is the earlier one that has.
    expect(pickup?.location).toMatchObject({ name: "Cologne" });
  });

  it("drives the courier along its loop with stops counting down", () => {
    const start = demoLiveReading(0);
    const later = demoLiveReading(4 * 60_000);
    expect(start).toMatchObject({ state: "en_route", stopsAway: 5 });
    expect(later.stopsAway).toBeLessThan(start.stopsAway ?? 0);
    expect(later.latitude).not.toBe(start.latitude);
    expect(demoLiveReading(9.9 * 60_000)).toMatchObject({ state: "next_stop", stopsAway: 0 });
  });
});
