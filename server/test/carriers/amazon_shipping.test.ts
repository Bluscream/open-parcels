import { describe, expect, it } from "vitest";
import { amazonShipping } from "../../src/carriers/amazon_shipping/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./harness.js";

// Made-up codes and values only.
const UK = "UK0000000001";
const US = "TBA000000000001";
const ROUTE_UK = `GET track.amazon.co.uk/api/tracker/${UK}`;
const ROUTE_US = `GET track.amazon.com/api/tracker/${US}`;
/** The tracker puts a narrow no-break space before AM/PM. */
const NARROW_SPACE = String.fromCharCode(0x202f);
const DEPOT = { city: "Testtown", countryCode: "GB" };

const ev = (eventCode: string, eventTime: string, location: unknown = DEPOT) => ({
  eventCode,
  eventTime,
  location,
});

/** The tracker sends three fields as JSON text inside the JSON body. */
function envelope(tracker: Record<string, unknown>, events: unknown[]) {
  return {
    progressTracker: JSON.stringify(tracker),
    eventHistory: JSON.stringify({ eventHistory: events }),
    addresses: JSON.stringify({}),
    shipperDetails: { shipperName: "Example Brand" },
  };
}

const served = (summary: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  trackerSource: "SWA",
  errors: [],
  summary,
  ...extra,
});

describe("Amazon Shipping tracking", () => {
  it("reads status, London-time history and the expected delivery", async () => {
    const w = new World(amazonShipping);
    const body = envelope(
      served({ status: "InTransit" }, { expectedDeliveryDate: "Nov 20, 2026" }),
      [
        ev("CreationConfirmed", "Nov 16, 2026, 9:00:00 AM"),
        ev("PickupDone", "Nov 17, 2026, 2:30:00 PM"),
        ev("Received", `Nov 18, 2026, 6:14:30${NARROW_SPACE}AM`),
      ],
    );
    w.routes = [on(ROUTE_UK, json(body))];
    const [parcel] = (await w.track([UK])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "amazon",
      barcode: UK,
      status: "in_transit",
      rawStatus: "InTransit",
      plannedFrom: "2026-11-20T00:00:00.000Z",
      sender: "Example Brand",
      url: `https://track.amazon.co.uk/tracking/${UK}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status, e.rawStatus])).toEqual([
      ["2026-11-18T06:14:30.000Z", "in_transit", "Received"],
      ["2026-11-17T14:30:00.000Z", "in_transit", "PickupDone"],
      ["2026-11-16T09:00:00.000Z", "registered", "CreationConfirmed"],
    ]);
    expect(w.unknown).toEqual([]);
  });

  it("reads a Departed scan right after OutForDelivery at the depot as the van leaving", async () => {
    const w = new World(amazonShipping);
    const body = envelope(served({}), [
      ev("Received", "Nov 18, 2026, 6:00:00 AM"),
      ev("OutForDelivery", "Nov 18, 2026, 8:00:00 AM"),
      ev("Departed", "Nov 18, 2026, 8:20:00 AM"),
    ]);
    w.routes = [on(ROUTE_UK, json(body))];
    const [parcel] = (await w.track([UK])).snapshots;
    expect(parcel?.status).toBe("out_for_delivery");
  });

  it("marks delivery from the Delivered event", async () => {
    const w = new World(amazonShipping);
    const body = envelope(
      served({ status: "Delivered" }, { expectedDeliveryDate: "Nov 18, 2026" }),
      [
        ev("OutForDelivery", "Nov 18, 2026, 8:00:00 AM"),
        ev("Delivered", "Nov 18, 2026, 11:45:00 AM"),
      ],
    );
    w.routes = [on(ROUTE_UK, json(body))];
    const [parcel] = (await w.track([UK])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T11:45:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats numbers the tracker does not serve as not found", async () => {
    const w = new World(amazonShipping);
    const notServed = envelope(
      { trackerSource: "UNKNOWN", errors: [{ errorCode: "TRACKING_ID_NOT_FOUND" }] },
      [],
    );
    w.routes = [on(ROUTE_US, json(notServed))];
    expect((await w.track([US])).snapshots).toEqual([]);
    expect(w.unknown).toEqual([]);
  });

  it("reports unmapped codes and only guesses from wording", async () => {
    const w = new World(amazonShipping);
    const body = envelope(served({ status: "Mystery" }), [
      ev("Received", "Nov 18, 2026, 6:00:00 AM"),
      ev("ReturnInitiated", "Nov 18, 2026, 9:00:00 AM"),
    ]);
    w.routes = [on(ROUTE_UK, json(body))];
    const [parcel] = (await w.track([UK])).snapshots;
    expect(parcel?.status).toBe("returning");
    expect(w.unknown).toContain("status_code:Mystery");
    expect(w.unknown).toContain("status_code:ReturnInitiated");
  });

  it("keeps US local times out of the history but still orders them", async () => {
    const w = new World(amazonShipping);
    const body = envelope(served({}), [
      ev("Received", "Nov 18, 2026, 6:00:00 AM"),
      ev("OutForDelivery", "Nov 18, 2026, 8:00:00 AM"),
    ]);
    w.routes = [on(ROUTE_US, json(body))];
    const [parcel] = (await w.track([US])).snapshots;
    expect(parcel).toMatchObject({ status: "out_for_delivery", history: [] });
  });

  it("stops on a broken nested field and passes network errors on", async () => {
    const broken = new World(amazonShipping);
    broken.routes = [on(ROUTE_UK, json({ progressTracker: "{not json" }))];
    await expect(broken.track([UK])).rejects.toBeInstanceOf(UnexpectedResponseError);

    const offline = new World(amazonShipping);
    offline.routes = [on(ROUTE_UK, new Error("offline"))];
    await expect(offline.track([UK])).rejects.toBeInstanceOf(TransientError);
  });
});
