import { describe, expect, it } from "vitest";
import { airmee } from "../../src/carriers/airmee/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, madeUp, on, world } from "./harness.js";

// Made-up tokens and values only.
const TOKEN = "linktoken-000001";
const ROUTE = "GET api.airmee.com/track/track_by_url";
const secret = { phoneNumberHash: madeUp("hash") };
const T0 = Date.UTC(2026, 10, 18, 8, 0) / 1000;

const event = (courier_status: string, offsetMinutes: number) => ({
  courier_status,
  time_of_event: T0 + offsetMinutes * 60,
});

function order(...timeline: ReturnType<typeof event>[]) {
  return {
    order_details: [{ id: "order-1", sender_name: "Example Shop", new_timeline: timeline }],
  };
}

describe("Airmee tracking", () => {
  it("reads the newest stage, the history and sends the hash with the token", async () => {
    const w = world(airmee);
    w.routes = [
      on(
        ROUTE,
        json(
          order(event("SCAN", 0), event("PICKUP_CONFIRMED", 60), event("ON_WAY_TO_DROPOFF", 120)),
        ),
      ),
    ];
    const [parcel] = (await w.track([TOKEN], {}, secret)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "airmee",
      barcode: TOKEN,
      status: "out_for_delivery",
      rawStatus: "ON_WAY_TO_DROPOFF",
      sender: "Example Shop",
      plannedFrom: null,
      plannedTo: null,
      url: `https://tracking.airmee.com/track/${TOKEN}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T10:00:00.000Z", "out_for_delivery"],
      ["2026-11-18T09:00:00.000Z", "in_transit"],
      ["2026-11-18T08:00:00.000Z", "registered"],
    ]);
    const sent = w.calls[0]?.url.searchParams;
    expect(sent?.get("tracking_url")).toBe(TOKEN);
    expect(sent?.get("phone_number_hash")).toBe(secret.phoneNumberHash);
  });

  it("marks delivery with the drop-off time and ignores order edits", async () => {
    const w = world(airmee);
    w.routes = [
      on(ROUTE, json(order(event("SCAN", 0), event("DROPOFF_CONFIRMED", 90), event("EDIT", 95)))),
    ];
    const [parcel] = (await w.track([TOKEN], {}, secret)).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:30:00.000Z",
    });
    expect(w.unknown).toEqual([]);
  });

  it("treats an empty order list as not found", async () => {
    const w = world(airmee);
    w.routes = [on(ROUTE, json({ order_details: [] }))];
    expect((await w.track([TOKEN], {}, secret)).snapshots).toEqual([]);
  });

  it("reports an unknown stage and falls back to the newest earlier one", async () => {
    const w = world(airmee);
    w.routes = [on(ROUTE, json(order(event("PICKUP_CONFIRMED", 0), event("TELEPORTED", 30))))];
    const [parcel] = (await w.track([TOKEN], {}, secret)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(w.unknown).toEqual(["status_code:TELEPORTED"]);
  });

  it("tells a refused hash apart from a network error", async () => {
    const refused = world(airmee);
    refused.routes = [on(ROUTE, json({}, 403))];
    await expect(refused.track([TOKEN], {}, secret)).rejects.toBeInstanceOf(SignInRejectedError);

    const offline = world(airmee);
    offline.routes = [on(ROUTE, new Error("offline"))];
    const failure = offline.track([TOKEN], {}, secret);
    await expect(failure).rejects.toBeInstanceOf(TransientError);
    await expect(failure).rejects.not.toBeInstanceOf(SignInRejectedError);
  });
});
