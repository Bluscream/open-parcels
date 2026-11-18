import { describe, expect, it } from "vitest";
import { sameday } from "../../src/carriers/sameday/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { fakeRoutes, harness } from "./route-harness.js";

// Made-up codes and values only.
const AWB = "9XTEST000001";
const OTHER = "9XTEST000002";
const route = (awb: string, tld = "ro") =>
  `GET api.sameday.${tld}/api/public/awb/${awb}/awb-history`;

const event = (statusStateId: number, statusDate: string, statusState: string) => ({
  statusStateId,
  statusDate,
  statusState,
  county: "Testjudet",
  transitLocation: "Testoras",
});

describe("Sameday tracking", () => {
  it("reads the newest event as the status and keeps the history newest first", async () => {
    const { fetchImpl, calls } = fakeRoutes({
      [route(AWB)]: [
        {
          status: 200,
          body: {
            awbHistory: [
              event(1, "2026-11-16T10:00:00Z", "Comanda plasata"),
              event(4, "2026-11-18T08:00:00Z", "In livrare"),
              event(3, "2026-11-17T10:00:00Z", "In depozit"),
            ],
          },
        },
      ],
    });
    const { plugin, base } = harness(sameday, fetchImpl);
    const result = await plugin.track(base, {}, null, [AWB]);
    expect(result.complete).toBe(true);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "sameday",
      barcode: AWB,
      status: "out_for_delivery",
      rawStatus: "In livrare",
      delivered: false,
      plannedFrom: null,
      plannedTo: null,
      url: `https://sameday.ro/status-colet/?awb=${AWB}`,
    });
    expect(result.snapshots[0]?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(calls[0]?.url.searchParams.get("_locale")).toBe("ro");
  });

  it("uses the configured country host and marks the locker as a pickup point", async () => {
    const { fetchImpl } = fakeRoutes({
      [route(AWB, "hu")]: [
        { status: 200, body: { awbHistory: [event(18, "2026-11-18T08:00:00Z", "Easybox")] } },
      ],
    });
    const { plugin, base } = harness(sameday, fetchImpl);
    const [parcel] = (await plugin.track(base, { country: "hu" }, null, [AWB])).snapshots;
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Testoras",
    });
  });

  it("treats 404 and an empty history as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeRoutes({
      [route(AWB)]: [{ status: 404, body: { error: { code: 404 } } }],
      [route(OTHER)]: [{ status: 200, body: { awbHistory: [] } }],
    });
    const { plugin, base } = harness(sameday, fetchImpl);
    const result = await plugin.track(base, {}, null, [AWB, OTHER, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports an unmapped status id and leaves the status null", async () => {
    const { fetchImpl } = fakeRoutes({
      [route(AWB)]: [
        { status: 200, body: { awbHistory: [event(99, "2026-11-18T08:00:00Z", "Nou")] } },
      ],
    });
    const { plugin, base, unknown } = harness(sameday, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [AWB])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["99"]);
  });

  it("stops on server errors and on answers without a history", async () => {
    const failing = fakeRoutes({ [route(AWB)]: [{ status: 500, body: {} }] });
    const one = harness(sameday, failing.fetchImpl);
    await expect(one.plugin.track(one.base, {}, null, [AWB])).rejects.toBeInstanceOf(
      TransientError,
    );
    const odd = fakeRoutes({ [route(AWB)]: [{ status: 200, body: { something: 1 } }] });
    const two = harness(sameday, odd.fetchImpl);
    await expect(two.plugin.track(two.base, {}, null, [AWB])).rejects.toThrow(/AWB history/);
  });
});
