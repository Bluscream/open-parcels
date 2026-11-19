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
import {
  chooseStops,
  distanceKm,
  usableCandidates,
  type RouteScan,
} from "../../src/geo/route-choice.js";
import { parcelForEvent } from "../../src/events/payload.js";
import { FakeWorld, fakePost, scan, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/** Made-up answers: a town, a city-state ranked as a state, and a country. */
const TOWN: Place = {
  label: "Testtown",
  latitude: 50.5,
  longitude: 8.25,
  rank: 16,
  kind: "town",
  importance: 0.4,
};
const CITY_STATE: Place = {
  label: "Hamburg, Germany",
  latitude: 53.55,
  longitude: 10,
  rank: 8,
  kind: "city",
  importance: 0.8,
};
const COUNTRY: Place = {
  label: "Testland",
  latitude: 51,
  longitude: 10,
  rank: 4,
  kind: "country",
  importance: 0.9,
};

function town(label: string, latitude: number, longitude: number, importance = 0.4): Place {
  return { label, latitude, longitude, rank: 16, kind: "town", importance };
}

/** The live cases: three places called Greven, and a Mayong that is not the one in Dongguan. */
const GREVEN = [
  town("Greven, Mecklenburg", 53.48, 10.8),
  town("Greven, Ludwigslust-Parchim", 53.48, 11.98, 0.35),
  town("Greven, Kreis Steinfurt", 52.09, 7.61),
];
const MUENSTER = town("Münster-Osnabrück", 52.27, 8.05);
const HANOVER = town("Hanover", 52.37, 9.74);
const MAYONG = town("Mayong, Jepara", -6.75, 110.76);
const DONGGUAN = town("Dongguan", 23.02, 113.75);
const HONG_KONG = town("Hong Kong", 22.28, 114.16);

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

type Scan = ReturnType<typeof scan>;

function list(history: Scan[]): void {
  world.listing = [
    snapshot({
      carrier: "fakepost",
      barcode: "FP0001",
      status: "in_transit",
      rawStatus: "On its way",
      history,
    }),
  ];
}

/** Polls the fake account again, with the carrier now reporting this history. */
async function refetch(history: Scan[]): Promise<void> {
  list(history);
  const source = await context.services.db.selectFrom("sources").select("id").executeTakeFirst();
  await context.services.runner.run(source?.id ?? "");
}

/** Latitude by place text, null for unplaced scans. */
async function latitudes(id: string): Promise<Record<string, number | null>> {
  const parcel = await context.services.parcels.repository.get(id);
  return Object.fromEntries(
    (parcel?.history ?? []).map((event) => [event.location ?? "", event.latitude]),
  );
}

async function track(history: Scan[]): Promise<string> {
  list(history);
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

describe("PlaceResolver with ambiguous names", () => {
  const at = (hour: number): string => `2026-11-18T${String(hour).padStart(2, "0")}:00:00Z`;

  it("picks the Greven on the route, not the search's first answer", async () => {
    search.answers.set("Greven", GREVEN);
    search.answers.set("Münster-Osnabrück", [MUENSTER]);
    search.answers.set("Hanover", [HANOVER]);
    const id = await track([
      scan(at(1), "Hub", "in_transit", "Münster-Osnabrück"),
      scan(at(2), "Depot", "in_transit", "Greven"),
      scan(at(3), "Hub", "in_transit", "Hanover"),
    ]);

    expect(await resolver.runOnce()).toEqual({ looked: 3, events: 3, parcels: 1 });
    expect(await latitudes(id)).toEqual({
      "Münster-Osnabrück": 52.27,
      Greven: 52.09,
      Hanover: 52.37,
    });
    expect(await located()).toHaveLength(1);
    // The same data gives the same answer: nothing moves, nobody is told again.
    expect(await resolver.runOnce()).toEqual({ looked: 0, events: 0, parcels: 0 });
    expect(await located()).toHaveLength(1);
  });

  it("leaves a name unplaced whose only answer is far off the route, repeats included", async () => {
    search.answers.set("Mayong Town", [MAYONG]);
    search.answers.set("Dongguan", [DONGGUAN]);
    search.answers.set("Hong Kong", [HONG_KONG]);
    const id = await track([
      scan(at(1), "Collected", "in_transit", "Dongguan"),
      scan(at(2), "Arrived", "in_transit", "Mayong Town"),
      scan(at(3), "Departed", "in_transit", "Mayong Town"),
      scan(at(4), "Export", "in_transit", "Hong Kong"),
    ]);

    expect(await resolver.runOnce()).toEqual({ looked: 3, events: 2, parcels: 1 });
    expect(await latitudes(id)).toEqual({
      Dongguan: 23.02,
      "Mayong Town": null,
      "Hong Kong": 22.28,
    });
    const parcel = await context.services.parcels.repository.get(id);
    expect(parcel?.history.filter((e) => e.location === "Mayong Town")).toEqual([
      expect.objectContaining({ latitude: null, approximate: false }),
      expect.objectContaining({ latitude: null, approximate: false }),
    ]);
  });

  it("keeps a far stop that has only one neighbour: the first leg of an import", async () => {
    search.answers.set("Dongguan", [DONGGUAN]);
    search.answers.set("Hanover", [HANOVER]);
    const id = await track([
      scan(at(1), "Collected", "in_transit", "Dongguan"),
      scan(at(2), "Arrived", "in_transit", "Hanover"),
    ]);
    await resolver.runOnce();
    expect(await latitudes(id)).toEqual({ Dongguan: 23.02, Hanover: 52.37 });
  });

  it("without any context takes the first answer only when it clearly leads", async () => {
    // Two equally known Grevens first: no telling which.
    search.answers.set("Greven", GREVEN);
    const id = await track([scan(at(1), "Depot", "in_transit", "Greven")]);
    expect(await resolver.runOnce()).toEqual({ looked: 1, events: 0, parcels: 0 });
    expect(await latitudes(id)).toEqual({ Greven: null });
    expect(await located()).toHaveLength(0);
    // Known as ambiguous, not asked again.
    expect(await resolver.runOnce()).toMatchObject({ looked: 0, events: 0 });

    search.answers.set("Hanover", [
      { ...HANOVER, importance: 0.72 },
      town("Hanover, New Hampshire", 43.7, -72.29, 0.55),
    ]);
    // A second scan whose first answer clearly leads starts the route, and Greven follows it:
    // Mecklenburg's (about 135 km from Hanover) is nearer than Steinfurt's (about 150 km).
    await refetch([scan(at(2), "Hub", "in_transit", "Hanover")]);
    expect(await resolver.runOnce()).toEqual({ looked: 1, events: 2, parcels: 1 });
    expect(await latitudes(id)).toEqual({ Greven: 53.48, Hanover: 52.37 });
  });

  it("moves a looked-up stop when a carrier position gives the route away", async () => {
    search.answers.set("Greven", [
      { ...GREVEN[0], importance: 0.6 },
      ...GREVEN.slice(1),
    ] as Place[]);
    const greven = scan(at(2), "Depot", "in_transit", "Greven");
    const id = await track([greven]);
    await resolver.runOnce();
    expect(await latitudes(id)).toEqual({ Greven: 53.48 });

    await refetch([
      { ...scan(at(1), "Hub", "in_transit", "FMO"), latitude: 52.13, longitude: 7.68 },
      greven,
    ]);
    expect(await resolver.runOnce()).toEqual({ looked: 0, events: 1, parcels: 1 });
    const parcel = await context.services.parcels.repository.get(id);
    expect(parcel?.history.map((e) => [e.location, e.latitude, e.approximate])).toEqual(
      expect.arrayContaining([
        ["FMO", 52.13, false],
        ["Greven", 52.09, true],
      ]),
    );
    expect(await located()).toHaveLength(2);
    expect(await resolver.runOnce()).toMatchObject({ events: 0, parcels: 0 });
    expect(await located()).toHaveLength(2);
  });

  it("clears a looked-up stop that better context contradicts, never a carrier's", async () => {
    search.answers.set("Mayong Town", [MAYONG]);
    const mayong = scan(at(2), "Arrived", "in_transit", "Mayong Town");
    const id = await track([mayong]);
    expect(await resolver.runOnce()).toMatchObject({ events: 1 });
    expect(await latitudes(id)).toEqual({ "Mayong Town": -6.75 });

    // The carrier's own positions: one near, one absurdly far. Neither is the resolver's to touch.
    await refetch([
      { ...scan(at(1), "Collected", "in_transit", "Dongguan"), latitude: 23.02, longitude: 113.75 },
      mayong,
      { ...scan(at(3), "Export", "in_transit", "Hong Kong"), latitude: 22.28, longitude: 114.16 },
      { ...scan(at(4), "Odd", "in_transit", "Nowhere"), latitude: -60, longitude: -120 },
    ]);
    expect(await resolver.runOnce()).toEqual({ looked: 0, events: 1, parcels: 1 });
    expect(await latitudes(id)).toEqual({
      Dongguan: 23.02,
      "Mayong Town": null,
      "Hong Kong": 22.28,
      Nowhere: -60,
    });
    const rows = await context.services.db
      .selectFrom("parcel_events")
      .select(["location_text", "geocoded"])
      .execute();
    expect(rows.every((row) => row.geocoded === 0)).toBe(true);
  });

  it("looks up again what the single-point cache had placed, and corrects it", async () => {
    // As after migration 0014: an event placed from the old cache, and no cache rows.
    const id = await track([
      scan(at(1), "Hub", "in_transit", "Münster-Osnabrück"),
      scan(at(2), "Depot", "in_transit", "Greven"),
      scan(at(3), "Hub", "in_transit", "Hanover"),
    ]);
    const { db } = context.services;
    await db
      .updateTable("parcel_events")
      .set({ latitude: 53.48, longitude: 10.8, geocoded: 1 })
      .where("location_text", "=", "Greven")
      .execute();
    search.answers.set("Greven", GREVEN);
    search.answers.set("Münster-Osnabrück", [MUENSTER]);
    search.answers.set("Hanover", [HANOVER]);

    expect(await resolver.runOnce()).toEqual({ looked: 3, events: 3, parcels: 1 });
    expect((await latitudes(id))["Greven"]).toBe(52.09);
    const cached = await db.selectFrom("places").selectAll().where("key", "=", "greven").execute();
    expect(JSON.parse(cached[0]?.candidates ?? "[]")).toHaveLength(3);
  });

  it("keeps an old looked-up point until its name has been looked up again", async () => {
    const names = Array.from({ length: LOOKUPS_PER_RUN }, (_, i) => `Place ${String(i)}`);
    const id = await track([
      ...names.map((name, i) => scan(at(i + 1), "Hop", null, name)),
      scan(at(20), "Depot", "in_transit", "Testtown"),
    ]);
    await context.services.db
      .updateTable("parcel_events")
      .set({ latitude: 1, longitude: 2, geocoded: 1 })
      .where("location_text", "=", "Testtown")
      .execute();
    search.answers.set("Testtown", [TOWN]);

    expect(await resolver.runOnce()).toEqual({ looked: LOOKUPS_PER_RUN, events: 0, parcels: 0 });
    expect((await latitudes(id))["Testtown"]).toBe(1);
    expect(await resolver.runOnce()).toEqual({ looked: 1, events: 1, parcels: 1 });
    expect((await latitudes(id))["Testtown"]).toBe(50.5);
  });
});

describe("chooseStops", () => {
  const candidates = (places: readonly Place[]) => usableCandidates(places);
  const open = (places: readonly Place[]): RouteScan => ({
    fixed: null,
    candidates: candidates(places),
  });

  it("drops repeats of one spot and everything behind a country or region", () => {
    expect(
      candidates([TOWN, { ...TOWN, label: "Testtown municipality", latitude: 50.55 }]),
    ).toEqual([{ label: "Testtown", latitude: 50.5, longitude: 8.25, importance: 0.4 }]);
    expect(candidates([COUNTRY, TOWN])).toEqual([]);
    expect(candidates([TOWN, COUNTRY])).toHaveLength(1);
    expect(candidates(GREVEN)).toHaveLength(3);
  });

  it("measures great-circle distances", () => {
    expect(distanceKm(MUENSTER, HANOVER)).toBeGreaterThan(110);
    expect(distanceKm(MUENSTER, HANOVER)).toBeLessThan(120);
    expect(distanceKm(DONGGUAN, MAYONG)).toBeGreaterThan(3_000);
  });

  it("resolves unambiguous names first, then ambiguous ones in order, each seeing the last", () => {
    // Only the last scan is unambiguous. Greven is chosen by it, then the middle name by both.
    const twins = [town("Twin, far", 40, -75), town("Twin, near", 52.2, 7.9)];
    const scans = [open(GREVEN), open(twins), open([MUENSTER])];
    const chosen = chooseStops(scans);
    expect(chosen.map((point) => point?.latitude)).toEqual([52.09, 52.2, 52.27]);
    expect(chooseStops(scans)).toEqual(chosen);
  });

  it("rejects every candidate of a name when all are implausible", () => {
    const far = [town("Far A", -6.75, 110.76), town("Far B", -33.9, 151.2)];
    const chosen = chooseStops([open([MUENSTER]), open(far), open([HANOVER])]);
    expect(chosen[1]).toBeNull();
  });

  it("keeps a long detour on a long leg, and a wide one that stays under the limit", () => {
    // Frankfurt between Dongguan and Hanover: far from both, hardly off the way.
    const frankfurt = town("Frankfurt", 50.11, 8.68);
    expect(chooseStops([open([DONGGUAN]), open([frankfurt]), open([HANOVER])])[1]).toMatchObject({
      latitude: 50.11,
    });
    // Munich between Münster and Hanover: some 900 km extra, under the 1,000 km limit.
    const munich = town("Munich", 48.14, 11.58);
    expect(chooseStops([open([MUENSTER]), open([munich]), open([HANOVER])])[1]).toMatchObject({
      latitude: 48.14,
    });
  });

  it("leaves carrier positions and scans without a looked-up name alone", () => {
    const chosen = chooseStops([
      { fixed: { latitude: 52.13, longitude: 7.68 }, candidates: null },
      { fixed: null, candidates: null },
      open([]),
      open(GREVEN),
    ]);
    expect(chosen).toEqual([
      undefined,
      undefined,
      null,
      expect.objectContaining({ latitude: 52.09 }),
    ]);
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
            {
              display_name: "X",
              lat: "1",
              lon: "2",
              place_rank: 4,
              addresstype: "country",
              importance: 0.7,
            },
            { display_name: "Y", lat: "3", lon: "4" },
          ]),
        ),
    });
    expect(await geocoder.search("a")).toEqual([
      { label: "X", latitude: 1, longitude: 2, rank: 4, kind: "country", importance: 0.7 },
      { label: "Y", latitude: 3, longitude: 4, rank: null, kind: null, importance: null },
    ]);
    await geocoder.search("b");
    await geocoder.search("c");
    expect(waits).toEqual([1_000, 1_000]);
  });
});
