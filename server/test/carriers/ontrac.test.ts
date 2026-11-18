import { describe, expect, it } from "vitest";
import { ontrac } from "../../src/carriers/ontrac/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import type { FetchLike } from "../../src/plugin/http.js";
import { fakeContext, fakeNetwork, json, type Answer } from "./harness.js";

// Made-up codes and values only.
const ACTIVE = "D10000000000001";
const DELIVERED = "D10000000000002";
const MISSING = "D10000000000003";

const plugin = register(ontrac);

/** Answers by the code at the end of the path; unscripted codes are not found. */
function fakeOnTrac(routes: Record<string, Answer[]>) {
  const calls: string[] = [];
  const { fetchImpl } = fakeNetwork([
    (call) => {
      const code = decodeURIComponent(call.url.pathname.split("/").at(-1) ?? "");
      calls.push(code);
      return routes[code]?.shift() ?? json({ Title: "Not Found" }, 404);
    },
  ]);
  return { fetchImpl, calls };
}

function context(fetchImpl: FetchLike) {
  const { base, unknownKeys } = fakeContext(ontrac.http, fetchImpl);
  return { base, unknown: unknownKeys };
}

function pkg(code: string, events: [string, string][], extra: Record<string, unknown> = {}) {
  return {
    Packages: [
      {
        Tracking: code,
        Weight: 2,
        WeightUnits: "lbs",
        Consignee: { Name: "Test Person", City: "Sampletown" },
        Events: events.map(([EventCode, UtcEventDateTime]) => ({
          EventCode,
          UtcEventDateTime,
          Status: "In Transit",
        })),
        ...extra,
      },
    ],
  };
}

describe("OnTrac public tracking", () => {
  it("maps the newest event and reads the expected delivery and history", async () => {
    const { fetchImpl } = fakeOnTrac({
      [ACTIVE]: [
        json(
          pkg(
            ACTIVE,
            [
              ["EXRL", "2026-11-16T10:00:00"],
              ["OFDL", "2026-11-18T08:00:00"],
              ["ARRD", "2026-11-17T10:00:00Z"],
            ],
            { UtcExpectedDeliveryDateTime: "2026-11-18T22:00:00Z" },
          ),
          200,
        ),
      ],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "ontrac",
      barcode: ACTIVE,
      status: "out_for_delivery",
      rawStatus: "OFDL",
      delivered: false,
      plannedTo: "2026-11-18T22:00:00.000Z",
      weightKg: 0.91,
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(parcel?.url).toContain(ACTIVE);
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
  });

  it("reports delivered with its time and no window", async () => {
    const { fetchImpl } = fakeOnTrac({
      [DELIVERED]: [
        json(
          pkg(DELIVERED, [["DLVD", "2026-11-18T09:00:00Z"]], {
            UtcDeliveryDateTime: "2026-11-18T09:00:00Z",
            UtcExpectedDeliveryDateTime: "2026-11-18T22:00:00Z",
          }),
          200,
        ),
      ],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [DELIVERED])).snapshots;
    expect(parcel).toMatchObject({
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      plannedTo: null,
    });
  });

  it("treats the structured 404 and an empty package list as not found", async () => {
    const { fetchImpl, calls } = fakeOnTrac({
      [MISSING]: [json({ Title: "Not Found", Status: 404 }, 404)],
      [ACTIVE]: [json({ Packages: [] }, 200)],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [MISSING, ACTIVE, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toEqual([MISSING, ACTIVE]);
  });

  it("reports an unmapped code once and keeps the status null", async () => {
    const { fetchImpl } = fakeOnTrac({
      [ACTIVE]: [
        json(
          pkg(ACTIVE, [
            ["NFRP", "2026-11-18T08:00:00Z"],
            ["NFRP", "2026-11-18T07:00:00Z"],
          ]),
          200,
        ),
      ],
    });
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [ACTIVE])).snapshots;
    expect(parcel).toMatchObject({ status: null, rawStatus: "NFRP", delivered: false });
    expect(unknown).toEqual(["NFRP"]);
  });

  it("stops fast on a network error, a 5xx or an unexpected 404 body", async () => {
    const network = fakeOnTrac({ [ACTIVE]: [new Error("offline")] });
    await expect(
      plugin.track(context(network.fetchImpl).base, {}, null, [ACTIVE, DELIVERED]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(network.calls).toEqual([ACTIVE]);

    const server = fakeOnTrac({ [ACTIVE]: [json({}, 502)] });
    await expect(
      plugin.track(context(server.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(TransientError);

    const odd = fakeOnTrac({ [ACTIVE]: [json({ message: "gone" }, 404)] });
    await expect(
      plugin.track(context(odd.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
