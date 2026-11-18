import { describe, expect, it } from "vitest";
import { postnl } from "../../src/carriers/postnl/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, on, World } from "./post-harness.js";

// Made-up codes and values only.
const CODE = "3STEST000000001";
const DONE = "3STEST000000002";
const TOKEN = "POST login.postnl.nl/101112a0-4a0f-4bbb-8176-2f1b2d370d7c/login/token";
const GRAPHQL = "POST jouw.postnl.nl/account/api/graphql";
const TNT = "GET jouw.postnl.nl/track-and-trace/api/trackAndTrace/";
const secret = { refreshToken: "rt-0" };
const tokens = (n: number) =>
  json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 600 });

const shipment = (barcode: string, extra: Record<string, unknown> = {}) => ({
  key: `key-${barcode}`,
  barcode,
  title: "Testwinkel",
  delivered: false,
  receiverTitle: "T. Persoon",
  detailsUrl: `https://jouw.postnl.nl/track-and-trace/${barcode}`,
  ...extra,
});

const list = (receiver: unknown[], sender: unknown[] = []) =>
  json({ data: { trackedShipments: { receiverShipments: receiver, senderShipments: sender } } });

const observation = (code: string, at: string) => ({
  observationCode: code,
  observationDate: at,
  description: `Stap ${code}`,
});

const tnt = (barcode: string, codes: [string, string][]) =>
  json({
    colli: {
      [barcode]: {
        statusPhase: { message: "Je pakket wordt vandaag bezorgd" },
        routeInformation: {
          plannedDeliveryTimeWindow: {
            startDateTime: "2026-11-18T13:00:00+01:00",
            endDateTime: "2026-11-18T15:00:00+01:00",
          },
          expectedDeliveryTime: "2026-11-18T13:40:00+01:00",
        },
        details: { dimensions: { weight: 1500 } },
        analyticsInfo: { allObservations: codes.map(([code, at]) => observation(code, at)) },
      },
    },
  });

describe("PostNL sign-in", () => {
  it("builds a PKCE login address and trades the pasted code for a refresh token", async () => {
    const world = new World(postnl, [on(TOKEN, tokens(1))]);
    const { url, state } = await world.plugin.startSignIn({}, world.clock);
    const login = new URL(url);
    expect(login.searchParams.get("code_challenge_method")).toBe("S256");
    const sent = login.searchParams.get("state") ?? "";
    const secretOut = await world.plugin.finishSignIn(
      world.base.http,
      world.clock,
      state,
      `https://www.postnl.nl/?code=c-1&state=${sent}`,
    );
    expect(secretOut).toEqual({ refreshToken: "rt-1" });
    expect(world.calls[0]?.body).toContain("code_verifier=");
    await expect(
      world.plugin.finishSignIn(
        world.base.http,
        world.clock,
        state,
        "https://www.postnl.nl/?code=c-1&state=other",
      ),
    ).rejects.toBeInstanceOf(SignInRejectedError);
  });
});

describe("PostNL account", () => {
  it("lists the shipments and reads each live one's track & trace", async () => {
    const world = new World(postnl, [
      on(TOKEN, tokens(1)),
      on(
        GRAPHQL,
        list([
          shipment(CODE),
          shipment(DONE, { delivered: true, deliveredTimeStamp: "2026-11-17T10:00:00Z" }),
        ]),
      ),
      on(
        TNT,
        tnt(CODE, [
          ["A03", "2026-11-16T09:00:00Z"],
          ["J01", "2026-11-17T09:00:00Z"],
          ["A19", "2026-11-18T07:00:00Z"],
          ["J05", "2026-11-18T08:00:00Z"],
        ]),
      ),
    ]);
    const result = await world.fetchAccount(secret);
    const [live, done] = result.snapshots;
    expect(live).toMatchObject({
      carrier: "postnl",
      barcode: CODE,
      status: "out_for_delivery",
      plannedFrom: "2026-11-18T12:40:00.000Z",
      plannedTo: "2026-11-18T14:00:00.000Z",
      weightKg: 1.5,
      sender: "Testwinkel",
      receiver: "T. Persoon",
    });
    // The ETA notice inherits the stage before it.
    expect(live?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "in_transit",
      "registered",
    ]);
    expect(done).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-17T10:00:00.000Z",
    });
    expect(world.paths().filter((p) => p.startsWith("GET"))).toHaveLength(1);
    expect(world.stored).toMatchObject({ refreshToken: "rt-1", accessToken: "at-1" });
  });

  it("reports an unknown observation code", async () => {
    const world = new World(postnl, [
      on(TOKEN, tokens(1)),
      on(GRAPHQL, list([shipment(CODE)])),
      on(
        TNT,
        tnt(CODE, [
          ["J01", "2026-11-17T09:00:00Z"],
          ["Q99", "2026-11-18T08:00:00Z"],
        ]),
      ),
    ]);
    const [parcel] = (await world.fetchAccount(secret)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(world.unknown).toEqual(["observation_code:Q99"]);
  });

  it("treats a refused refresh token as a sign-in problem", async () => {
    const world = new World(postnl, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(world.fetchAccount(secret)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("never refreshes again after a network error", async () => {
    const world = new World(postnl, [on(TOKEN, tokens(1)), on(GRAPHQL, new TypeError("offline"))]);
    await expect(world.fetchAccount(secret)).rejects.toBeInstanceOf(TransientError);
    expect(world.paths().filter((p) => p === TOKEN)).toHaveLength(1);
  });
});
