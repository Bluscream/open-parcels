import { describe, expect, it } from "vitest";
import { colisweb } from "../../src/carriers/colisweb/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./kit-harness.js";

// Made-up codes and values only.
const CODE = "TESTCW000001";

describe("Colisweb tracking", () => {
  it("reads status, the slot and the milestones", async () => {
    const world = new World(colisweb);
    world.routes = [
      on(
        "/api/search",
        json({
          searchValue: CODE,
          step: "OUT_FOR_DELIVERY",
          clientName: "Example Shop",
          startsAt: "2026-11-18T13:00:00Z",
          endsAt: "2026-11-18T15:00:00Z",
          deliveryConfirmationDate: "2026-11-16T10:00:00Z",
          pickedUpDate: "2026-11-18T07:00:00Z",
          recipient: { name: "Test Person" },
        }),
      ),
    ];
    const [parcel] = (await world.track([CODE], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "colisweb",
      status: "out_for_delivery",
      sender: "Example Shop",
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual(["in_transit", "registered"]);
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
    expect(world.calls[0]?.init.body).toBe(JSON.stringify({ value: CODE }));
  });

  it("treats 404 as not found", async () => {
    const world = new World(colisweb);
    world.routes = [on("/api/search", json({}, 404))];
    expect((await world.track([CODE], {}, null)).snapshots).toEqual([]);
  });

  it("reports an unknown step and falls back to the milestones", async () => {
    const world = new World(colisweb);
    world.routes = [
      on(
        "/api/search",
        json({ searchValue: CODE, step: "TELEPORTED", pickedUpDate: "2026-11-18T07:00:00Z" }),
      ),
    ];
    const [parcel] = (await world.track([CODE], {}, null)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(world.unknown).toEqual(["status_code:TELEPORTED"]);
  });

  it("stops when the reply is for another number", async () => {
    const world = new World(colisweb);
    world.routes = [on("/api/search", json({ searchValue: "OTHER" }))];
    await expect(world.track([CODE], {}, null)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
