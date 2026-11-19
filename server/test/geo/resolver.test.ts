import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOP_MS } from "../../src/carriers/demo/data.js";
import { demoCarrier } from "../../src/carriers/demo/index.js";
import { register } from "../../src/engine/registry.js";
import { Geocoder, GeocodeError, isStopPrecise, type Place } from "../../src/geo/geocoder.js";
import {
  LOOKUPS_PER_RUN,
  MISS_RETRY_MS,
  PlaceResolver,
  type PlaceSearch,
} from "../../src/geo/resolver.js";
import { parcelForEvent } from "../../src/events/payload.js";
import { FakeWorld, fakePost, scan, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/** Made-up answers: a town, a city-state ranked as a state, and a country. */
const TOWN: Place = { label: "Testtown", latitude: 50.5, longitude: 8.25, rank: 16, kind: "town" };
const CITY_STATE: Place = {
  label: "Hamburg, Germany",
  latitude: 53.55,
  longitude: 10,
  rank: 8,
  kind: "city",
};
const COUNTRY: Place = { label: "Testland", latitude: 51, longitude: 10, rank: 4, kind: "country" };

class FakeSearch implements PlaceSearch {
  readonly asked: string[] = [];
  answers = new Map<string, readonly Place[]>();
  failing = false;

  search(query: string): Promise<readonly Place[]> {
    this.asked.push(query);
    if (this.failing) return Promise.reject(new GeocodeError("down"));
    return Promise.resolve(this.answers.get(query) ?? []);
  }
}

let context: TestContext;
let world: FakeWorld;
let search: FakeSearch;
let resolver: PlaceResolver;

beforeEach(async () => {
  world = new FakeWorld();
  context = await createTestContext({ plugins: [fakePost(world), register(demoCarrier)] });
  search = new FakeSearch();
  const { db, bus, clock, logger } = context.services;
  resolver = new PlaceResolver({
    db,
    geocoder: search,
    bus,
    clock,
    logger,
    presentation: { position: () => undefined, imagePath: (r) => r, labelMode: () => "items" },
  });
});
afterEach(async () => {
  await context.close();
});

async function track(history: ReturnType<typeof scan>[]): Promise<string> {
  world.listing = [
    snapshot({
      carrier: "fakepost",
      barcode: "FP0001",
      status: "in_transit",
      rawStatus: "On its way",
      history,
    }),
  ];
  const source = await context.services.sources.create({
    plugin: "fakepost",
    kind: "account",
    label: "Fake account",
    config: {},
    secret: { username: "user@example.invalid", password: ["made", "up"].join("-") },
  });
  await context.services.runner.run(source.id);
  const id = await context.services.parcels.repository.findIdByBarcode("fakepost", "FP0001");
  if (id === undefined) throw new Error("not stored");
  return id;
}

async function located(type = "parcel.location_changed") {
  return context.services.db.selectFrom("outbox").selectAll().where("type", "=", type).execute();
}

describe("PlaceResolver", () => {
  it("places scans that name a town, marks them approximate and tells clients", async () => {
    search.answers.set("testtown", [TOWN]);
    const id = await track([scan("2026-11-18T07:00:00Z", "Sorted", "in_transit", " testtown ")]);

    expect(await resolver.runOnce()).toEqual({ looked: 1, events: 1, parcels: 1 });
    // Only the place text leaves the server, trimmed.
    expect(search.asked).toEqual(["testtown"]);
    const parcel = await context.services.parcels.repository.get(id);
    expect(parcel?.history[0]).toMatchObject({
      latitude: 50.5,
      longitude: 8.25,
      approximate: true,
    });
    expect(parcel?.location).toMatchObject({ source: "event", precision: "area", latitude: 50.5 });
    expect(await located()).toHaveLength(1);
  });

  it("does not use countries or regions as stops, and remembers the miss for 30 days", async () => {
    search.answers.set("Testland", [COUNTRY, TOWN]);
    const id = await track([scan("2026-11-18T07:00:00Z", "Abroad", "in_transit", "Testland")]);

    expect(await resolver.runOnce()).toMatchObject({ looked: 1, events: 0 });
    expect((await context.services.parcels.repository.get(id))?.location).toBeNull();
    expect(await resolver.runOnce()).toMatchObject({ looked: 0 });

    context.clock.advance(MISS_RETRY_MS + 1000);
    expect(await resolver.runOnce()).toMatchObject({ looked: 1, events: 0 });
    expect(search.asked).toEqual(["Testland", "Testland"]);
    expect(await located()).toHaveLength(0);
  });

  it("looks each name up once ever and a few per run", async () => {
    const names = Array.from({ length: LOOKUPS_PER_RUN + 2 }, (_, i) => `Place ${String(i)}`);
    await track(names.map((name, i) => scan(`2026-11-18T0${String(i)}:00:00Z`, "Hop", null, name)));

    expect((await resolver.runOnce()).looked).toBe(LOOKUPS_PER_RUN);
    expect((await resolver.runOnce()).looked).toBe(2);
    expect((await resolver.runOnce()).looked).toBe(0);
    expect(new Set(search.asked).size).toBe(names.length);
  });

  it("records nothing while the service is down, and asks again next run", async () => {
    search.answers.set("Testtown", [TOWN]);
    await track([scan("2026-11-18T07:00:00Z", "Sorted", "in_transit", "Testtown")]);
    search.failing = true;
    expect(await resolver.runOnce()).toMatchObject({ looked: 0, events: 0 });
    search.failing = false;
    expect(await resolver.runOnce()).toMatchObject({ looked: 1, events: 1 });
  });

  it("lets the carrier's own position replace a looked-up one", async () => {
    search.answers.set("Testtown", [TOWN]);
    const event = scan("2026-11-18T07:00:00Z", "Sorted", "in_transit", "Testtown");
    const id = await track([event]);
    await resolver.runOnce();

    world.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
        history: [{ ...event, latitude: 52.1, longitude: 13.2 }],
      }),
    ];
    const source = await context.services.db.selectFrom("sources").select("id").executeTakeFirst();
    await context.services.runner.run(source?.id ?? "");
    const parcel = await context.services.parcels.repository.get(id);
    expect(parcel?.history[0]).toMatchObject({ latitude: 52.1, approximate: false });
    expect(parcel?.location).toMatchObject({ precision: "exact", latitude: 52.1 });
    // And the resolver does not overwrite it again.
    expect(await resolver.runOnce()).toMatchObject({ events: 0 });
  });

  it("places the demo courier's Hamburg scan, and events still carry no courier position", async () => {
    search.answers.set("Hamburg", [CITY_STATE]);
    const courier = await context.services.sources.create({
      plugin: "demo",
      kind: "account",
      label: "demo",
      config: {},
      secret: null,
    });
    const into = (context.clock.now().getTime() % LOOP_MS) / 1000;
    context.clock.advance((200 - into) * 1000);
    await context.services.runner.run(courier.id);

    expect(await resolver.runOnce()).toMatchObject({ events: 1, parcels: 1 });
    const id = await context.services.parcels.repository.findIdByBarcode("demo", "DEMO0000000002");
    const parcel = await context.services.parcels.repository.get(id ?? "");
    expect(parcel?.history.find((e) => e.location === "Hamburg")).toMatchObject({
      latitude: 53.55,
      approximate: true,
    });
    if (parcel === undefined) throw new Error("demo parcel missing");
    const [stored] = await located();
    const payload = JSON.parse(stored?.payload ?? "{}") as { parcel: unknown };
    expect(payload.parcel).toEqual(JSON.parse(JSON.stringify(parcelForEvent(parcel))));
  });
});

describe("place precision", () => {
  it("takes cities, towns and finer, and city-states, but not countries or regions", () => {
    expect(isStopPrecise(TOWN)).toBe(true);
    expect(isStopPrecise(CITY_STATE)).toBe(true);
    expect(isStopPrecise({ ...TOWN, rank: 21, kind: "postcode" })).toBe(true);
    expect(isStopPrecise(COUNTRY)).toBe(false);
    expect(isStopPrecise({ ...TOWN, rank: 8, kind: "state" })).toBe(false);
    expect(isStopPrecise({ ...TOWN, rank: 12, kind: "county" })).toBe(false);
    expect(isStopPrecise({ ...TOWN, rank: null, kind: null })).toBe(false);
  });

  it("reads Nominatim's rank and type, one request a second", async () => {
    let clock = 100_000;
    const waits: number[] = [];
    const geocoder = new Geocoder({
      userAgent: "test",
      now: () => clock,
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      fetchImpl: () =>
        Promise.resolve(
          Response.json([
            { display_name: "X", lat: "1", lon: "2", place_rank: 4, addresstype: "country" },
          ]),
        ),
    });
    expect(await geocoder.search("a")).toEqual([
      { label: "X", latitude: 1, longitude: 2, rank: 4, kind: "country" },
    ]);
    await geocoder.search("b");
    await geocoder.search("c");
    expect(waits).toEqual([1_000, 1_000]);
  });
});
