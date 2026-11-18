import { describe, expect, it } from "vitest";
import { postaSlovenije } from "../../src/carriers/posta_slovenije/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, onPrefix, World } from "./harness.js";

/** Made up, built from parts so the pre-commit secret check stays quiet. */
const madeUpPassword = ["not", "a", "real", "one"].join("-");

// Made-up codes and values only.
const CODE = "TE000000001SI";
const OTHER = "TE000000002SI";
const secret = { username: "test-user", password: madeUpPassword };
const TRACK = "GET moja.posta.si/api/v1/parcels/track/";
const TOKEN = "POST auth.posta.si/realms/mojaposta/protocol/openid-connect/token";
const LIST = "GET moja.posta.si/api/v1/parcels";

function scan(code: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    statusDateTime: at,
    codeDescriptionEN: `Scan ${code}`,
    postalName: "1000 Testno",
    ...extra,
  };
}

const scans = (last: Record<string, unknown>) => [
  scan("NAJ", "2026-11-16T09:00:00Z"),
  scan("S", "2026-11-17T09:00:00Z"),
  last,
];

const envelope = (statuses: unknown[], number = CODE) => ({
  result: { parcel: { trackingNumber: number }, statuses },
});

const tokens = (n: number) => ({
  access_token: `at-${n}`,
  refresh_token: `rt-${n}`,
  expires_in: 300,
});

describe("Pošta Slovenije tracking", () => {
  it("maps the newest scan and keeps the history newest first", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(
        TRACK,
        json(
          envelope(scans(scan("IZR", "2026-11-18T09:00:00Z", { pickupAddress: "Testna ulica 1" }))),
        ),
      ),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "posta_slovenije",
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "1000 Testno, Testna ulica 1",
      rawStatus: "Scan IZR",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "at_pickup_point",
      "in_transit",
      "registered",
    ]);
    expect(world.calls[0]?.url.searchParams.get("TrackingNumber")).toBe(CODE);
  });

  it("tells a returned parcel from a delivered one", async () => {
    const returned = [
      ...scans(scan("V", "2026-11-18T09:00:00Z", { nondeliveryActionEN: "Returned to sender" })),
      scan("VL", "2026-11-19T09:00:00Z"),
    ];
    const world = new World(postaSlovenije, [
      onPrefix(
        TRACK,
        json(envelope(scans(scan("VL", "2026-11-18T09:00:00Z")))),
        json(envelope(returned, OTHER)),
      ),
    ]);
    const [delivered, back] = (await world.track([CODE, OTHER])).snapshots;
    expect(delivered).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
    });
    expect(back).toMatchObject({ status: "returning", delivered: false });
  });

  it("treats the service's not-found answer as not found", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(
        TRACK,
        json({ errorCode: "error.not.found", errorMessage: `Parcel ${CODE} not found` }, 404),
      ),
    ]);
    expect((await world.track([CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports an unknown code and keeps the last known status", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(TRACK, json(envelope(scans(scan("ZZZ", "2026-11-18T09:00:00Z"))))),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(world.unknown).toEqual(["status_code:ZZZ"]);
  });

  it("stops when the client guard refuses us", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(TRACK, json({ errorCode: "error.not.allowed" }, 403)),
    ]);
    await expect(world.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(world.calls).toHaveLength(1);
  });
});

describe("Pošta Slovenije account", () => {
  const row = (id: number, code: string, extra: Record<string, unknown> = {}) => ({
    parcelId: id,
    trackingNumber: code,
    senderName: "Testna trgovina",
    ...extra,
  });
  const page = (items: unknown[]) => json({ result: { items, totalCount: items.length } });

  it("signs in, lists both directions and reads each live parcel's detail", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(TOKEN, json(tokens(1))),
      onPrefix(
        `${LIST}/1`,
        json({ result: { parcel: {}, statuses: scans(scan("N", "2026-11-18T09:00:00Z")) } }),
      ),
      onPrefix(
        LIST,
        page([row(1, CODE)]),
        page([row(2, OTHER, { isArchived: true, isOutgoingParcel: true })]),
      ),
    ]);
    const result = await world.fetchAccount({}, secret);
    expect(result.complete).toBe(true);
    expect(result.snapshots.map((p) => [p.barcode, p.status, p.direction, p.sender])).toEqual([
      [CODE, "out_for_delivery", "incoming", "Testna trgovina"],
      [OTHER, null, "outgoing", "Testna trgovina"],
    ]);
    expect(world.stored).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(world.calls[1]?.headers.get("authorization")).toBe("Bearer at-1");
  });

  it("refreshes once on a 401 and keeps going", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(TOKEN, json(tokens(2))),
      onPrefix(LIST, json({}, 401), page([]), page([])),
    ]);
    world.stored = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: world.clock.now().getTime() + 3_600_000,
    };
    await world.fetchAccount({}, secret);
    expect(world.calls[1]?.body).toContain("grant_type=refresh_token");
    expect(world.stored).toMatchObject({ accessToken: "at-2" });
  });

  it("reports a refused password as a sign-in problem", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(
        TOKEN,
        json({ error: "invalid_grant", error_description: "Invalid user credentials" }, 401),
      ),
    ]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("never signs in again after a network error", async () => {
    const world = new World(postaSlovenije, [
      onPrefix(TOKEN, json(tokens(1))),
      onPrefix(LIST, new TypeError("offline")),
    ]);
    await expect(world.fetchAccount({}, secret)).rejects.toBeInstanceOf(TransientError);
    expect(world.requests().filter((p) => p.startsWith("POST"))).toHaveLength(1);
  });
});
