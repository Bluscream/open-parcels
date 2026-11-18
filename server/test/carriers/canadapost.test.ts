import { describe, expect, it } from "vitest";
import { canadapost } from "../../src/carriers/canadapost/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, onFragment, World, type Route } from "./harness.js";

// Made-up codes and values only.
const PIN = "TESTPIN000000001";
const OTHER = "TESTPIN000000002";
const credentials = { username: "test-user", password: ["made", "up"].join("-") };

function detail(pin: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    pin,
    status,
    custNm: "Example Shop",
    expectedDlvryDateTime: { dlvryDate: "2026-11-19" },
    events: [
      {
        cd: "0174",
        type: "Out",
        descEn: "Out for delivery",
        datetime: { date: "2026-11-18", time: "08:15:00", zoneOffset: "-05:00" },
        locationAddr: { city: "Testville", regionCd: "ON" },
      },
      {
        cd: "9999",
        type: "Induction",
        descEn: "Item accepted",
        datetime: { date: "2026-11-17", time: "10:00:00", zoneOffset: "-05:00" },
      },
    ],
    ...extra,
  };
}

const detailRoute = (pin: string, body: unknown): Route =>
  onFragment(`/package/${pin}/detail`, json(body));
const tokens = (n: number) => ({
  access_token: `at-${n}`,
  id_token: `id-${n}`,
  refresh_token: `rt-${n}`,
  expires_in: 3600,
});
const list = (...pins: string[]) => ({
  data: {
    listTrackSyncItems: {
      items: [
        ...pins.map((pin) => ({ trackId: pin, deleted: false })),
        { trackId: "TESTPIN000000099", deleted: true },
      ],
      nextToken: null,
    },
  },
});

describe("Canada Post tracking", () => {
  it("reads status, delivery day and history", async () => {
    const world = new World(canadapost);
    world.routes = [detailRoute(PIN, detail(PIN, "FullProgress"))];
    const [parcel] = (await world.track([PIN], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "canadapost",
      status: "out_for_delivery",
      rawStatus: "FullProgress",
      sender: "Example Shop",
      plannedFrom: "2026-11-19T05:00:00.000Z",
      plannedTo: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status, e.location])).toEqual([
      ["2026-11-18T13:15:00.000Z", "out_for_delivery", "Testville, ON"],
      ["2026-11-17T15:00:00.000Z", "in_transit", null],
    ]);
  });

  it("returns nothing when the body carries an error", async () => {
    const world = new World(canadapost);
    world.routes = [detailRoute(PIN, { error: { cd: "004" } })];
    expect((await world.track([PIN], {}, null)).snapshots).toEqual([]);
  });

  it("falls back to events for an unknown status and reports it when nothing maps", async () => {
    const world = new World(canadapost);
    world.routes = [
      detailRoute(PIN, detail(PIN, "Brandnew")),
      detailRoute(OTHER, { pin: OTHER, status: "Brandnew", events: [] }),
    ];
    const [first, second] = (await world.track([PIN, OTHER], {}, null)).snapshots;
    expect(first?.status).toBe("out_for_delivery");
    expect(second?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:Brandnew"]);
  });

  it("marks a returned parcel as returning", async () => {
    const world = new World(canadapost);
    world.routes = [detailRoute(PIN, detail(PIN, "InTransit", { returnedToSender: true }))];
    const [parcel] = (await world.track([PIN], {}, null)).snapshots;
    expect(parcel?.status).toBe("returning");
  });
});

describe("Canada Post account", () => {
  it("signs in, lists the PINs and reads each one's detail", async () => {
    const world = new World(canadapost);
    world.routes = [
      onFragment("/oauth20/token", json(tokens(1))),
      onFragment("/graphql", json(list(PIN))),
      detailRoute(PIN, detail(PIN, "Delivered", { delivered: true })),
    ];
    const result = await world.fetchAccount({}, credentials);
    expect(result.snapshots.map((p) => [p.barcode, p.status, p.delivered])).toEqual([
      [PIN, "delivered", true],
    ]);
    expect(world.calls[0]?.body ?? "").toContain("grant_type=password");
    expect(new Headers(world.calls[1]?.init.headers).get("authorization")).toBe("id-1");
    expect(world.stored).toMatchObject({ idToken: "id-1", refreshToken: "rt-1" });
  });

  it("refreshes a refused token once before signing in again", async () => {
    const world = new World(canadapost);
    world.stored = { accessToken: "a", idToken: "old", refreshToken: "rt-0", expiresAt: null };
    world.routes = [
      onFragment(
        "/graphql",
        json({ errors: [{ errorType: "UnauthorizedException" }] }),
        json(list()),
      ),
      onFragment("/oauth20/token", json(tokens(2))),
    ];
    await world.fetchAccount({}, credentials);
    expect(world.requests().filter((p) => p.includes("token"))).toHaveLength(1);
    expect(world.calls[1]?.body ?? "").toContain("grant_type=refresh_token");
  });

  it("asks the user to sign in again when the password is refused", async () => {
    const world = new World(canadapost);
    world.routes = [onFragment("/oauth20/token", json({ error: "invalid_grant" }, 401))];
    await expect(world.fetchAccount({}, credentials)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("never signs in again on a network error", async () => {
    const world = new World(canadapost);
    world.stored = { accessToken: "a", idToken: "old", refreshToken: "rt-0", expiresAt: null };
    world.routes = [onFragment("/graphql", new Error("ECONNRESET"))];
    await expect(world.fetchAccount({}, credentials)).rejects.toBeInstanceOf(TransientError);
    expect(world.requests().some((p) => p.includes("token"))).toBe(false);
  });
});
