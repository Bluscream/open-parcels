import { describe, expect, it } from "vitest";
import { acsCourier } from "../../src/carriers/acs-courier/index.js";
import { RateLimitedError, TransientError } from "../../src/plugin/errors.js";
import { html, json, on, world } from "./harness.js";

// Made-up codes and values only.
const CODE = "9900000001";
const PAGE = "GET www.acscourier.net/en/quick-access/non-registered-users/track-and-trace/";
const SEARCH = `GET api.acscourier.net/api/parcels/search/${CODE}`;
const page = (token: string) => html(`<script>var publicToken = "${token}";</script>`);

function point(controlPid: number, controlPointDate: string, controlPoint: string) {
  return { controlPid, controlParentPid: null, controlPointDate, controlPoint, description: "" };
}

function item(statusId: number | null, extra: Record<string, unknown> = {}) {
  return {
    items: [
      {
        trackingNumber: CODE,
        shipmentStatusId: statusId,
        expectedDeliveryDate: "2026-11-20T00:00:00",
        sender: "Example Shop",
        recipientName: "Test Person",
        statusHistory: [
          point(300, "2026-11-18T09:30:00", "On the way to the hub"),
          point(100, "2026-11-17T10:00:00", "Picked up"),
          point(306, "2026-11-17T11:00:00", "Notice sent"),
        ],
        ...extra,
      },
    ],
  };
}

describe("ACS Courier tracking", () => {
  it("reads status, Athens-time history and a whole-day window", async () => {
    const w = world(acsCourier);
    w.routes = [on(PAGE, page("tok-1")), on(SEARCH, json(item(null)))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "acs-courier",
      barcode: CODE,
      status: "in_transit",
      rawStatus: "On the way to the hub",
      plannedFrom: "2026-11-19T22:00:00.000Z",
      plannedTo: "2026-11-20T21:59:59.000Z",
      sender: "Example Shop",
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T07:30:00.000Z", "in_transit"],
      ["2026-11-17T09:00:00.000Z", null],
      ["2026-11-17T08:00:00.000Z", "in_transit"],
    ]);
    expect(w.calls[1]?.headers.get("x-encrypted-key")).toBe("tok-1");
    expect(w.stored).toEqual({ token: "tok-1" });
  });

  it("takes delivered from the parcel status id and clears the window", async () => {
    const w = world(acsCourier);
    w.stored = { token: "tok-1" };
    w.routes = [on(SEARCH, json(item(4, { deliveryDate: "2026-11-18T12:00:00" })))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T10:00:00.000Z",
      plannedFrom: null,
    });
    expect(w.requests()).toEqual([SEARCH]);
  });

  it("treats the not-found note and a JSON 404 as not found", async () => {
    const w = world(acsCourier);
    w.stored = { token: "tok-1" };
    w.routes = [
      on(SEARCH, json({ items: [{ notes: "Shipment not found" }] }), json({ title: "nf" }, 404)),
    ];
    expect((await w.track([CODE])).snapshots).toEqual([]);
    expect((await w.track([CODE])).snapshots).toEqual([]);
  });

  it("reports an unmapped control point and status id", async () => {
    const w = world(acsCourier);
    w.stored = { token: "tok-1" };
    const body = item(9, {
      statusHistory: [point(777, "2026-11-18T09:30:00", "Something new")],
    });
    w.routes = [on(SEARCH, json(body))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_code:controlPid:777", "status_code:shipmentStatusId:9"]);
  });

  it("replaces a refused token once, then pauses instead of retrying", async () => {
    const w = world(acsCourier);
    w.stored = { token: "old" };
    w.routes = [on(PAGE, page("tok-2")), on(SEARCH, json({}, 401), json({}, 401))];
    await expect(w.track([CODE])).rejects.toBeInstanceOf(RateLimitedError);
    expect(w.requests()).toEqual([SEARCH, PAGE, SEARCH]);
    expect(w.stored).toBeNull();
  });

  it("does not fetch a new token on a network error", async () => {
    const w = world(acsCourier);
    w.stored = { token: "tok-1" };
    w.routes = [on(SEARCH, new Error("offline"))];
    await expect(w.track([CODE])).rejects.toBeInstanceOf(TransientError);
    expect(w.requests()).toEqual([SEARCH]);
  });
});
