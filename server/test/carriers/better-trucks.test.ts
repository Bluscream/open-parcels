import { describe, expect, it } from "vitest";
import { betterTrucks } from "../../src/carriers/better-trucks/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, on, world } from "./harness.js";

// Made-up codes and values only.
const CODE = "BTS_TEST0000001";
const ROUTE = `GET tracking.bettertrucks.com/api/tracking/${CODE}`;

const event = (status: string, object_created: string) => ({
  status,
  object_created,
  event_details: { FailureReason: null, DropoffLocation: "Front Door" },
});

function found(current: string, at: string, history: ReturnType<typeof event>[]) {
  return {
    tracking_number: CODE,
    shipment_tracking_number: CODE,
    eta: "2026-11-19T18:00:00",
    original_eta: "2026-11-19T18:00:00",
    address_from: { city: "Testtown", state: "TS" },
    address_to: { city: "Sampleville", state: "SV" },
    tracking_status: { status: current, object_created: at },
    tracking_history: history,
  };
}

describe("Better Trucks tracking", () => {
  it("reads status, hub scans, history and the expected delivery", async () => {
    const w = world(betterTrucks);
    w.routes = [
      on(
        ROUTE,
        json(
          found("SCANNED_AT_HUB_XYZ", "2026-11-18T09:00:00", [
            event("SCANNED_AT_HUB_XYZ", "2026-11-18T09:00:00"),
            event("INJECTED", "2026-11-17T20:00:00"),
            event("SHIPMENT_CREATED", "2026-11-17T08:00:00"),
          ]),
        ),
      ),
    ];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "better-trucks",
      barcode: CODE,
      status: "in_transit",
      rawStatus: "SCANNED_AT_HUB_XYZ",
      plannedFrom: "2026-11-19T18:00:00.000Z",
      plannedTo: null,
      url: `https://tracking.bettertrucks.com/track/${CODE}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T09:00:00.000Z", "in_transit"],
      ["2026-11-17T20:00:00.000Z", "in_transit"],
      ["2026-11-17T08:00:00.000Z", "registered"],
    ]);
    expect(w.calls[0]?.url.searchParams.get("isFromExternalTracking")).toBe("true");
    expect(w.unknown).toEqual([]);
  });

  it("marks delivery, drops the window and honours a zone option", async () => {
    const w = world(betterTrucks);
    w.routes = [
      on(
        ROUTE,
        json(
          found("DELIVERED", "2026-11-18T14:00:00", [event("DELIVERED", "2026-11-18T14:00:00")]),
        ),
      ),
    ];
    const [parcel] = (await w.track([CODE], { timeZone: "America/Chicago" })).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T20:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats the UNKNOWN answer as not found", async () => {
    const w = world(betterTrucks);
    w.routes = [
      on(
        ROUTE,
        json({
          tracking_number: CODE,
          tracking_status: { status: "UNKNOWN" },
          tracking_history: [],
        }),
      ),
    ];
    expect((await w.track([CODE])).snapshots).toEqual([]);
  });

  it("reports an unmapped status once", async () => {
    const w = world(betterTrucks);
    w.routes = [
      on(
        ROUTE,
        json(
          found("RETURN_TO_SENDER", "2026-11-18T09:00:00", [
            event("RETURN_TO_SENDER", "2026-11-18T09:00:00"),
          ]),
        ),
      ),
    ];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_code:RETURN_TO_SENDER"]);
  });

  it("passes unexpected answers and network errors on", async () => {
    const down = world(betterTrucks);
    down.routes = [on(ROUTE, json({}, 500))];
    await expect(down.track([CODE])).rejects.toBeInstanceOf(TransientError);
    const offline = world(betterTrucks);
    offline.routes = [on(ROUTE, new Error("offline"))];
    await expect(offline.track([CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
