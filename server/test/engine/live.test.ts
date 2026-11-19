import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_FAST_MS, LIVE_PROBE_MS } from "../../src/engine/live.js";
import type { EphemeralMessage } from "../../src/events/bus.js";
import { RateLimitedError, TransientError } from "../../src/plugin/api.js";
import { FakeWorld, fakeShop, reading, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Made-up coordinates far from anywhere real. */
const COURIER = { latitude: 10.5, longitude: 20.25 };

let context: TestContext;
let shop: FakeWorld;
let sourceId: string;
let positions: EphemeralMessage[];

beforeEach(async () => {
  shop = new FakeWorld();
  context = await createTestContext({ plugins: [fakeShop(shop)] });
  sourceId = (
    await context.services.sources.create({
      plugin: "fakeshop",
      kind: "shop",
      label: "Shop",
      config: {},
      secret: null,
    })
  ).id;
  positions = [];
  context.services.bus.subscribeEphemeral((message) => positions.push(message));
});
afterEach(async () => {
  await context.close();
});

async function poll(
  status: "in_transit" | "out_for_delivery" | "delivered",
  mapShown = false,
): Promise<string> {
  shop.listing = [
    snapshot({
      carrier: "fakeshop",
      barcode: "SHOP-1",
      status,
      rawStatus: status,
      live: { ref: { trackingId: "made-up-1" }, mapShown },
    }),
  ];
  await context.services.sources.requestRun(sourceId);
  await context.services.scheduler.runDue();
  return (
    (await context.services.parcels.repository.list({ includeArchived: true }, false))[0]?.id ?? ""
  );
}

async function liveEvents(): Promise<Record<string, unknown>[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select(["type", "payload"])
    .where("type", "=", "parcel.live_updated")
    .orderBy("seq")
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("live courier tracking", () => {
  it("probes every five minutes while out for delivery without a map, then reads every 30 s", async () => {
    await poll("out_for_delivery");
    shop.liveScript = [null];
    expect(await context.services.live.pass()).toBe(LIVE_PROBE_MS);
    shop.liveScript = [reading("en_route", 12, COURIER)];
    expect(await context.services.live.pass()).toBe(LIVE_FAST_MS);
  });

  it("does not read parcels that are not out for delivery and show no map", async () => {
    await poll("in_transit");
    expect(await context.services.live.pass()).toBeNull();
    expect(shop.liveCalls).toHaveLength(0);
  });

  it("fires live_updated on start, state and stop changes, but never for a position alone", async () => {
    const parcelId = await poll("out_for_delivery", true);
    shop.liveScript = [
      reading("en_route", 12, COURIER),
      reading("en_route", 12, { latitude: 10.6, longitude: 20.3 }),
      reading("en_route", 13, COURIER),
      reading("next_stop", 0, COURIER),
    ];
    for (let pass = 0; pass < 4; pass += 1) {
      await context.services.live.pass();
    }
    const events = await liveEvents();
    expect(
      events.map((event) => [
        event["old_live_state"],
        event["new_live_state"],
        event["new_stops_away"],
      ]),
    ).toEqual([
      [null, "en_route", 12],
      ["en_route", "en_route", 13],
      ["en_route", "next_stop", 0],
    ]);
    expect(positions).toHaveLength(3);
    const parcel = await context.services.parcels.repository.get(parcelId);
    // From next_stop on, coordinates are never published.
    expect(parcel?.live).toMatchObject({
      state: "next_stop",
      stops_away: 0,
      latitude: null,
      longitude: null,
    });
  });

  it("never stores or emits coordinates in events or the database", async () => {
    await poll("out_for_delivery", true);
    shop.liveScript = [reading("en_route", 5, COURIER)];
    await context.services.live.pass();
    const outbox = await context.services.db.selectFrom("outbox").select("payload").execute();
    const liveRows = await context.services.db.selectFrom("live_state").selectAll().execute();
    const stored = JSON.stringify([outbox, liveRows]);
    expect(stored).not.toContain("10.5");
    expect(stored).not.toContain("20.25");
    // The API overlays the in-memory position while the courier is en route.
    const parcel = (await context.services.parcels.repository.list({}, false))[0];
    expect(parcel?.live).toMatchObject({
      latitude: COURIER.latitude,
      longitude: COURIER.longitude,
    });
  });

  it("asks for an immediate full poll when the session reports delivered", async () => {
    await poll("out_for_delivery", true);
    shop.liveScript = [reading("en_route", 1, COURIER), reading("delivered", 0)];
    await context.services.live.pass();
    context.clock.advance(30_000);
    await context.services.live.pass();
    const source = await context.services.sources.get(sourceId);
    expect(Date.parse(source?.nextRunAt ?? "")).toBeLessThanOrEqual(context.clock.now().getTime());

    shop.listing = [
      snapshot({
        carrier: "fakeshop",
        barcode: "SHOP-1",
        status: "delivered",
        rawStatus: "Delivered",
      }),
    ];
    await context.services.scheduler.runDue();
    const types = (
      await context.services.db
        .selectFrom("outbox")
        .select("type")
        .where("type", "like", "parcel.%")
        .orderBy("seq")
        .execute()
    ).map((row) => row.type);
    expect(types.slice(-1)).toEqual(["parcel.delivered"]);
    expect(await context.services.live.pass()).toBeNull();
  });

  it("does not re-read an ended session while the parcel is still listed out for delivery", async () => {
    await poll("out_for_delivery", true);
    shop.liveScript = [reading("en_route", 1, COURIER), reading("ended", null)];
    await context.services.live.pass();
    await context.services.live.pass();
    await poll("out_for_delivery", false);
    shop.liveScript = [reading("ended", null)];
    expect(await context.services.live.pass()).toBeNull();
    expect((await liveEvents()).map((event) => event["new_live_state"])).toEqual([
      "en_route",
      "ended",
    ]);
  });

  it("stops after three failed passes until the next full poll, and honours Retry-After", async () => {
    await poll("out_for_delivery", true);
    shop.liveScript = [new RateLimitedError("slow", 120)];
    expect(await context.services.live.pass()).toBe(120_000);
    shop.liveScript = [new TransientError("x"), new TransientError("x")];
    await context.services.live.pass();
    await context.services.live.pass();
    expect(await context.services.live.pass()).toBeNull();
    expect(shop.liveCalls).toHaveLength(3);
    await poll("out_for_delivery", true);
    shop.liveScript = [reading("en_route", 3, COURIER)];
    expect(await context.services.live.pass()).toBe(LIVE_FAST_MS);
  });
});
