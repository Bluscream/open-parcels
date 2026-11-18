import { describe, expect, it } from "vitest";
import { slovenskaPosta } from "../../src/carriers/slovenska-posta/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { fakeRoutes, harness, type Reply } from "./route-harness.js";

// Made-up codes and values only.
const CODE = "RR000000001SK";
const OTHER = "RR000000002SK";
const BAD = "XX000000003SK";
const ROUTE = "GET api.posta.sk/tracking";

const event = (stateCode: string, localDate: string, detailDescription: string) => ({
  stateCode,
  localDate,
  detailDescription,
  postOffice: { name: "Testovacia posta 1" },
});

const results = (list: unknown[]): Reply => ({ status: 200, body: { results: list } });

describe("Slovenská pošta tracking", () => {
  it("batches codes and reads status, local times, pickup point and history", async () => {
    const { fetchImpl, calls } = fakeRoutes({
      [ROUTE]: [
        results([
          {
            number: CODE,
            events: [
              event("received", "2026-11-16T10:00:00", "Prijatie"),
              event("notified", "2026-11-18T08:00:00", "Ulozene na poste"),
              event("transit", "2026-11-17T10:00:00", "Preprava"),
            ],
          },
          { number: OTHER, events: [] },
          { number: BAD, status: "invalid_format" },
        ]),
      ],
    });
    const { plugin, base } = harness(slovenskaPosta, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, OTHER, BAD]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("q")).toBe(`${CODE},${OTHER},${BAD}`);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "slovenska-posta",
      barcode: CODE,
      status: "at_pickup_point",
      rawStatus: "notified: Ulozene na poste",
      pickup: true,
      pickupPoint: "Testovacia posta 1",
      plannedFrom: null,
      plannedTo: null,
    });
    expect(result.snapshots[0]?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T07:00:00.000Z", "at_pickup_point"],
      ["2026-11-17T09:00:00.000Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "registered"],
    ]);
  });

  it("treats a missing result as not found", async () => {
    const { fetchImpl } = fakeRoutes({ [ROUTE]: [results([])] });
    const { plugin, base } = harness(slovenskaPosta, fetchImpl);
    expect(await plugin.track(base, {}, null, [CODE, "../x"])).toEqual({
      snapshots: [],
      complete: true,
    });
  });

  it("reports an unknown state code", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [results([{ number: CODE, events: [event("lost", "2026-11-18T08:00:00", "?")] }])],
    });
    const { plugin, base, unknown } = harness(slovenskaPosta, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["lost"]);
  });

  it("stops on server errors and answers without a result list", async () => {
    const one = harness(
      slovenskaPosta,
      fakeRoutes({ [ROUTE]: [{ status: 500, body: {} }] }).fetchImpl,
    );
    await expect(one.plugin.track(one.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
    const two = harness(
      slovenskaPosta,
      fakeRoutes({ [ROUTE]: [{ status: 200, body: {} }] }).fetchImpl,
    );
    await expect(two.plugin.track(two.base, {}, null, [CODE])).rejects.toThrow(/result list/);
  });
});
