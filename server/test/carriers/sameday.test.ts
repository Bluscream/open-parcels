import { describe, expect, it } from "vitest";
import { sameday } from "../../src/carriers/sameday/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(sameday);

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
    const { fetchImpl, calls } = network({
      [route(AWB)]: [
        json(
          {
            awbHistory: [
              event(1, "2026-11-16T10:00:00Z", "Comanda plasata"),
              event(4, "2026-11-18T08:00:00Z", "In livrare"),
              event(3, "2026-11-17T10:00:00Z", "In depozit"),
            ],
          },
          200,
        ),
      ],
    });
    const { base } = fakeContext(sameday.http, fetchImpl);
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
    const { fetchImpl } = network({
      [route(AWB, "hu")]: [
        json({ awbHistory: [event(18, "2026-11-18T08:00:00Z", "Easybox")] }, 200),
      ],
    });
    const { base } = fakeContext(sameday.http, fetchImpl);
    const [parcel] = (await plugin.track(base, { country: "hu" }, null, [AWB])).snapshots;
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Testoras",
    });
  });

  it("treats 404 and an empty history as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = network({
      [route(AWB)]: [json({ error: { code: 404 } }, 404)],
      [route(OTHER)]: [json({ awbHistory: [] }, 200)],
    });
    const { base } = fakeContext(sameday.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [AWB, OTHER, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports an unmapped status id and leaves the status null", async () => {
    const { fetchImpl } = network({
      [route(AWB)]: [json({ awbHistory: [event(99, "2026-11-18T08:00:00Z", "Nou")] }, 200)],
    });
    const { base, unknownKeys: unknown } = fakeContext(sameday.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [AWB])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["99"]);
  });

  it("stops on server errors and on answers without a history", async () => {
    const failing = network({ [route(AWB)]: [json({}, 500)] });
    const one = fakeContext(sameday.http, failing.fetchImpl);
    await expect(plugin.track(one.base, {}, null, [AWB])).rejects.toBeInstanceOf(TransientError);
    const odd = network({ [route(AWB)]: [json({ something: 1 }, 200)] });
    const two = fakeContext(sameday.http, odd.fetchImpl);
    await expect(plugin.track(two.base, {}, null, [AWB])).rejects.toThrow(/AWB history/);
  });
});
