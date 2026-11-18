import { describe, expect, it } from "vitest";
import { slovenskaPosta } from "../../src/carriers/slovenska_posta/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(slovenskaPosta);

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

const results = (list: unknown[]): Answer => json({ results: list }, 200);

describe("Slovenská pošta tracking", () => {
  it("batches codes and reads status, local times, pickup point and history", async () => {
    const { fetchImpl, calls } = network({
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
    const { base } = fakeContext(slovenskaPosta.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, OTHER, BAD]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("q")).toBe(`${CODE},${OTHER},${BAD}`);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "slovenska_posta",
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
    const { fetchImpl } = network({ [ROUTE]: [results([])] });
    const { base } = fakeContext(slovenskaPosta.http, fetchImpl);
    expect(await plugin.track(base, {}, null, [CODE, "../x"])).toEqual({
      snapshots: [],
      complete: true,
    });
  });

  it("reports an unknown state code", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [results([{ number: CODE, events: [event("lost", "2026-11-18T08:00:00", "?")] }])],
    });
    const { base, unknownKeys: unknown } = fakeContext(slovenskaPosta.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["lost"]);
  });

  it("stops on server errors and answers without a result list", async () => {
    const one = fakeContext(slovenskaPosta.http, network({ [ROUTE]: [json({}, 500)] }).fetchImpl);
    await expect(plugin.track(one.base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    const two = fakeContext(slovenskaPosta.http, network({ [ROUTE]: [json({}, 200)] }).fetchImpl);
    await expect(plugin.track(two.base, {}, null, [CODE])).rejects.toThrow(/result list/);
  });
});
