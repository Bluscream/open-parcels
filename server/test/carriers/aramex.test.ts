import { describe, expect, it } from "vitest";
import { aramex } from "../../src/carriers/aramex/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, on, world } from "./harness.js";

// Made-up labels and values only.
const LABEL = "AX0000000001";
const AU = "GET www.aramex.com.au/umbraco/api/TrackingApi/GetTrackingData";
const NZ = "GET www.aramex.co.nz/umbraco/api/TrackingApi/GetTrackingData";

const scan = (Status: string, RealDateTime: string, StatusDescription: string) => ({
  Status,
  RealDateTime,
  StatusDescription,
  Name: "Test Person",
});

function found(eta: string, ...Scans: ReturnType<typeof scan>[]) {
  return {
    generated_in: "0.1s",
    result: { LabelNumber: LABEL, DeliveryETADate: eta, Scans, ConsigneeName: "Test Person" },
  };
}

describe("Aramex tracking", () => {
  it("reads the newest scan, Sydney-time history and a whole-day window", async () => {
    const w = world(aramex);
    w.routes = [
      on(
        AU,
        json(
          found(
            "20/11/2026",
            scan("PP8", "2026-11-17T09:00:00", "Label created"),
            scan("ONB", "2026-11-18T07:30:00", "On board for delivery"),
            scan("TRN", "2026-11-17T20:00:00", "In transit"),
          ),
        ),
      ),
    ];
    const [parcel] = (await w.track([LABEL])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "aramex",
      barcode: LABEL,
      status: "out_for_delivery",
      rawStatus: "On board for delivery",
      plannedFrom: "2026-11-19T13:00:00.000Z",
      plannedTo: "2026-11-20T12:59:59.000Z",
      url: `https://www.aramex.com.au/tools/track?l=${LABEL}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-17T20:30:00.000Z", "out_for_delivery"],
      ["2026-11-17T09:00:00.000Z", "in_transit"],
      ["2026-11-16T22:00:00.000Z", "registered"],
    ]);
    expect(w.calls[0]?.url.searchParams.get("LabelNo")).toBe(LABEL);
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
  });

  it("uses the New Zealand site and zone when configured, and marks delivery", async () => {
    const w = world(aramex);
    w.routes = [on(NZ, json(found("18/11/2026", scan("YES", "2026-11-18T13:00:00", "Delivered"))))];
    const [parcel] = (await w.track([LABEL], { country: "NZ" })).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T00:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats an answer without scans as not found", async () => {
    const w = world(aramex);
    w.routes = [on(AU, json({ result: { Scans: null } }))];
    expect((await w.track([LABEL])).snapshots).toEqual([]);
  });

  it("reports an unmapped scan code", async () => {
    const w = world(aramex);
    w.routes = [on(AU, json(found("", scan("ZZ9", "2026-11-18T07:30:00", "Something new"))))];
    const [parcel] = (await w.track([LABEL])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_code:ZZ9"]);
  });

  it("passes server and network errors on", async () => {
    const down = world(aramex);
    down.routes = [on(AU, json({}, 502))];
    await expect(down.track([LABEL])).rejects.toBeInstanceOf(TransientError);
    const offline = world(aramex);
    offline.routes = [on(AU, new Error("offline"))];
    await expect(offline.track([LABEL])).rejects.toBeInstanceOf(TransientError);
  });
});
