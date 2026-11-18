import { describe, expect, it } from "vitest";
import { posti } from "../../src/carriers/posti/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onPrefix, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "JJFI00000000000001";
const OTHER = "JJFI00000000000002";
const MINT = "POST auth-service.posti.fi/api/v1/anonymous_token";
const SEARCH = "POST graphql.posti.fi/graphql";
const token = (n: number) =>
  json({ id_token: `id-${n}`, role_tokens: [{ type: "anonymous", token: `anon-${n}` }] });

function hit(main: string, newest: string, extra: Record<string, unknown> = {}) {
  return json({
    data: {
      consumerSearchShipments: {
        totalHits: 1,
        hits: [
          {
            status: { main },
            measurements: { weight: { unit: "g", value: "500" } },
            delivery: {
              destination: { name: ["Testi Henkilö"] },
              time: {
                type: "ESTIMATE",
                timestamp: "2026-11-19T08:00:00Z",
                timestampLatest: "2026-11-19T16:00:00Z",
              },
            },
            pickupPoint: { address: { publicName: "Testipiste" } },
            events: [
              { timestamp: "2026-11-18T08:00:00Z", eventDescription: newest, city: "TESTILÄ" },
              {
                timestamp: "2026-11-17T08:00:00Z",
                eventDescription: "The item is in sorting.",
                city: "VANTAA",
              },
              {
                timestamp: "2026-11-16T08:00:00Z",
                eventDescription: "Item has been registered.",
                city: null,
              },
            ],
            ...extra,
          },
        ],
      },
    },
  });
}

describe("Posti tracking", () => {
  it("mints an anonymous token, maps the events and reads the window", async () => {
    const world = new World(posti, [
      onPrefix(MINT, token(1)),
      onPrefix(SEARCH, hit("IN_TRANSPORT", "Item is in delivery transportation.")),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "posti",
      status: "out_for_delivery",
      plannedFrom: "2026-11-19T08:00:00.000Z",
      plannedTo: "2026-11-19T16:00:00.000Z",
      weightKg: 0.5,
      receiver: "Testi Henkilö",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(world.calls[1]?.headers.get("authorization")).toBe("anon-1");
    expect(world.calls[1]?.headers.get("x-posti-token")).toBe("Bearer id-1");
    expect(world.calls[1]?.body).not.toContain("pinCode");
    // The unmapped `status.main` is reported once; the events still give a status.
    expect(world.unknown).toEqual(["status_code:IN_TRANSPORT"]);
  });

  it("takes a delivery from status.main", async () => {
    const world = new World(posti, [
      onPrefix(MINT, token(1)),
      onPrefix(SEARCH, hit("DELIVERED", "The item has been delivered.")),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T08:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats zero hits as not found", async () => {
    const world = new World(posti, [
      onPrefix(MINT, token(1)),
      onPrefix(SEARCH, json({ data: { consumerSearchShipments: { totalHits: 0, hits: [] } } })),
    ]);
    expect((await world.track([CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports new event wording", async () => {
    const world = new World(posti, [
      onPrefix(MINT, token(1)),
      onPrefix(SEARCH, hit("DELIVERED", "Something new happened.")),
    ]);
    await world.track([CODE]);
    expect(world.unknown).toEqual(["event_text:something new happened"]);
  });

  it("mints once more when the token is refused, then gives up", async () => {
    const refused = json({ data: null, errors: [{ errorType: "Unauthorized" }] });
    const world = new World(posti, [
      onPrefix(MINT, token(1), token(2)),
      onPrefix(SEARCH, refused, json({}, 401)),
    ]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(TransientError);
    expect(world.requests().filter((p) => p === MINT)).toHaveLength(2);
  });

  it("stops on a network error without minting again", async () => {
    const world = new World(posti, [
      onPrefix(MINT, token(1)),
      onPrefix(SEARCH, new TypeError("offline")),
    ]);
    await expect(world.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(world.calls).toHaveLength(2);
  });
});
