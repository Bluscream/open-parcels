import { describe, expect, it } from "vitest";
import { boxNow } from "../../src/carriers/box_now/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./harness.js";

// Made-up codes, lockers and values only.
const CODE = "9000000001";
const GR = "POST api-production.boxnow.gr/api/v1/parcels:track";
const BG = "POST api-production.boxnow.bg/api/v1/parcels:track";

const ev = (type: string, createTime: string, locationDisplayName = "BOX NOW - Testtown") => ({
  type,
  createTime,
  postalCode: "00000",
  locationDisplayName,
});

function found(state: string, ...events: ReturnType<typeof ev>[]) {
  return { data: [{ id: CODE, state, events, paymentAmount: "0.00" }] };
}

describe("BOX NOW tracking", () => {
  it("falls back to the newest event and names the locker the parcel waits in", async () => {
    const w = new World(boxNow);
    w.routes = [
      on(
        GR,
        json(
          found(
            "in-progress",
            ev("new", "2026-11-16T10:00:00Z", "Depot"),
            ev("final-destination", "2026-11-18T08:00:00Z", "BOX NOW - Locker 1"),
            ev("in-depot", "2026-11-17T09:00:00Z", "Depot"),
          ),
        ),
      ),
    ];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "box_now",
      barcode: CODE,
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "BOX NOW - Locker 1",
      plannedFrom: null,
      plannedTo: null,
      url: `https://boxnow.gr/homepage-gr?track=${CODE}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T08:00:00.000Z", "at_pickup_point"],
      ["2026-11-17T09:00:00.000Z", "in_transit"],
      ["2026-11-16T10:00:00.000Z", "registered"],
    ]);
    expect(JSON.parse(w.calls[0]?.body ?? "{}")).toEqual({ parcelId: CODE });
    expect(JSON.stringify(parcel?.raw)).not.toContain("paymentAmount");
    // The parcel state only names outcomes; an in-flight one is normal when an event stands in.
    expect(w.unknown).toEqual([]);
  });

  it("uses the configured country and reads delivery from the state", async () => {
    const w = new World(boxNow);
    w.routes = [on(BG, json(found("delivered", ev("delivered", "2026-11-18T12:00:00Z"))))];
    const [parcel] = (await w.track([CODE], { country: "bg" })).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T12:00:00.000Z",
      url: `https://boxnow.bg/homepage?track=${CODE}`,
    });
  });

  it("treats an empty data list as not found", async () => {
    const w = new World(boxNow);
    w.routes = [on(GR, json({ data: [] }))];
    expect((await w.track([CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown event type", async () => {
    const w = new World(boxNow);
    w.routes = [on(GR, json(found("delivered", ev("teleported", "2026-11-18T12:00:00Z"))))];
    await w.track([CODE]);
    expect(w.unknown).toEqual(["status_code:event:teleported"]);
  });

  it("stops on a malformed item and passes network errors on", async () => {
    const odd = new World(boxNow);
    odd.routes = [on(GR, json({ data: ["x"] }))];
    await expect(odd.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
    const offline = new World(boxNow);
    offline.routes = [on(GR, new Error("offline"))];
    await expect(offline.track([CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
