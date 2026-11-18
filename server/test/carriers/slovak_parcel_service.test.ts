import { describe, expect, it } from "vitest";
import { slovakParcelService } from "../../src/carriers/slovak_parcel_service/index.js";
import { slovakTime } from "../../src/carriers/slovak_parcel_service/parse.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeRoutes, harness, type Reply } from "./route-harness.js";

// Made-up codes and values only.
const CODE = "TEST00000001";
const ROUTE = "POST rest.mysps.sk/tracking/getShipmentTrackAndTrace";

const state = (statusCode: string, status: number, time: string, statusDescr: string) => ({
  statusCode,
  status,
  time,
  statusDescr,
});

const found = (states: unknown[], extra: object = {}): Reply => ({
  status: 200,
  body: { status: true, code: 200, data: { shipmentNr: CODE, states, ...extra } },
});

describe("Slovak Parcel Service tracking", () => {
  it("reads the current scan, Slovak local times and the history", async () => {
    const { fetchImpl, calls } = fakeRoutes({
      [ROUTE]: [
        found(
          [
            state("TOUR", 30, "2026-11-18 08:00:00", "Na ceste"),
            state("PICK", 44, "2026-11-17 10:00:00", "Odnaska"),
            state("INIT", 10, "2026-11-16 10:00:00", "Prijate"),
          ],
          { lastStatusScan: "TOUR", shipmentStatus: "on the way" },
        ),
      ],
    });
    const { plugin, base } = harness(slovakParcelService, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "slovak_parcel_service",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Na ceste",
      plannedFrom: null,
      plannedTo: null,
      url: `https://mysps.sk/sk/tracking/${CODE}`,
    });
    // November is CET, one hour ahead of UTC.
    expect(result.snapshots[0]?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T07:00:00.000Z", "out_for_delivery"],
      ["2026-11-17T09:00:00.000Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "registered"],
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ shipmentNr: CODE });
  });

  it("honours the shipment-level delivered flag", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [
        found([state("DELY", 40, "2026-07-01 12:00:00", "Dorucene")], {
          shipmentStatus: "delivered",
        }),
      ],
    });
    const { plugin, base } = harness(slovakParcelService, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    // July is CEST, two hours ahead of UTC.
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-07-01T10:00:00.000Z" });
  });

  it("treats a false status envelope as not found", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [{ status: 200, body: { status: false, code: 404, data: null } }],
    });
    const { plugin, base } = harness(slovakParcelService, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports unknown codes but not the known no-movement ones", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [
        found([state("ZZZZ", 77, "2026-11-18 08:00:00", "Nove")]),
        found([state("DDSP", 38, "2026-11-18 08:00:00", "Upresnenie")]),
      ],
    });
    const { plugin, base, unknown } = harness(slovakParcelService, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, CODE]);
    expect(result.snapshots.map((p) => p.status)).toEqual([null, null]);
    expect(unknown).toEqual(["ZZZZ"]);
  });

  it("stops when the transport key is refused or the server fails", async () => {
    const refused = harness(
      slovakParcelService,
      fakeRoutes({ [ROUTE]: [{ status: 401, body: {} }] }).fetchImpl,
    );
    await expect(refused.plugin.track(refused.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const failing = harness(
      slovakParcelService,
      fakeRoutes({ [ROUTE]: [{ status: 500, body: {} }] }).fetchImpl,
    );
    await expect(failing.plugin.track(failing.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });

  it("parses times that already carry an offset", () => {
    expect(slovakTime("2026-11-18T08:00:00Z")).toBe("2026-11-18T08:00:00.000Z");
    expect(slovakTime("nonsense")).toBeNull();
  });
});
