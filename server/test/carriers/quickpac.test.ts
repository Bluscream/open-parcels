import { describe, expect, it } from "vitest";
import { quickpac } from "../../src/carriers/quickpac/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, onPrefix, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "99000000000000001";
const OTHER = "99000000000000002";
const lookup = (code: string) =>
  `GET parcelsearch.quickpac.ch/api/ParcelSearch/GetPublicTracking/${code}`;
const STARTUP = "GET parcelsearch.quickpac.ch/api/ParcelSearch/GetTrackingStartup";

function record(last: number, extra: Record<string, unknown> = {}) {
  return {
    IdentCode: CODE,
    LastStatus: "Neuester Status",
    LastStatusCode: last,
    Protocol: [
      { Time: "2026-11-16T10:00:00", Status: 1000, StatusText: "Angemeldet" },
      { Time: "2026-11-17T10:00:00", Status: 1201, StatusText: "Sortiert" },
      { Time: "2026-11-18T08:00:00", Status: last, StatusText: "Neuester Status" },
    ],
    ...extra,
  };
}

describe("Quickpac tracking", () => {
  it("maps the code groups and reads Swiss local times", async () => {
    const world = new World(quickpac, [onPrefix(lookup(CODE), json(record(1801)))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "quickpac",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Neuester Status",
      delivered: false,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T08:00:00+01:00", "out_for_delivery"],
      ["2026-11-17T10:00:00+01:00", "in_transit"],
      ["2026-11-16T10:00:00+01:00", "registered"],
    ]);
    expect(parcel?.url).toContain(CODE);
  });

  it("reports a delivery with its time", async () => {
    const world = new World(quickpac, [onPrefix(lookup(CODE), json(record(2104)))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T08:00:00+01:00",
    });
  });

  it("treats a 400 as not found only when the start-up call works", async () => {
    const world = new World(quickpac, [
      onPrefix(lookup(CODE), json({}, 400)),
      onPrefix(STARTUP, json({})),
    ]);
    expect((await world.track([CODE, "../x"])).snapshots).toEqual([]);
    const broken = new World(quickpac, [
      onPrefix(lookup(CODE), json({}, 400)),
      onPrefix(STARTUP, json({}, 404)),
    ]);
    await expect(broken.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("reports an info-group code as unknown", async () => {
    const world = new World(quickpac, [onPrefix(lookup(CODE), json(record(3100)))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:3100"]);
  });

  it("stops on a network error", async () => {
    const world = new World(quickpac, [onPrefix(lookup(CODE), new TypeError("offline"))]);
    await expect(world.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(world.calls).toHaveLength(1);
  });
});
