import { describe, expect, it } from "vitest";
import { trunkrs } from "../../src/carriers/trunkrs/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { fakeContext, fakeFetch } from "./fake-carrier.js";

// Made-up values only.
const CODE = "TR0000000001";
const POSTCODE = "9999 ZZ";
const DETAILS = "GET api.trunkrs.app/v2/tracing/details";
const plugin = register(trunkrs);
const config = { postalCode: POSTCODE };

function payload(state: string, extra: Record<string, unknown> = {}) {
  return {
    trunkrsNr: CODE,
    senderName: "Voorbeeldwinkel",
    currentState: { stateName: state, setAt: "2026-11-18T14:05:00Z" },
    timeSlot: {
      low: "2026-11-18T09:00:00Z",
      high: "2026-11-18T22:00:00Z",
      from: "2026-11-18T13:00:00Z",
      to: "2026-11-18T15:00:00Z",
    },
    deliveryAttempts: [
      { stateName: "DATA_PROCESSED", setAt: "2026-11-17T08:00:00Z" },
      { stateName: "SHIPMENT_SORTED", setAt: "2026-11-18T05:00:00Z" },
      { stateName: state, setAt: "2026-11-18T08:00:00Z" },
    ],
    auditLogs: [{ userSub: "driver-made-up" }],
    ...extra,
  };
}

describe("Trunkrs tracking", () => {
  it("reads status, the narrow window and the history, with the postcode as credentials", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [DETAILS]: [{ status: 200, body: payload("SHIPMENT_ACCEPTED_BY_DRIVER") }],
    });
    const { base, unknown } = fakeContext(trunkrs.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "trunkrs",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      sender: "Voorbeeldwinkel",
      url: "https://parcel.trunkrs.nl/TR0000000001/9999ZZ",
    });
    expect(result.snapshots[0]?.history.map((event) => event.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(JSON.stringify(result.snapshots[0]?.raw)).not.toContain("driver-made-up");
    const auth = calls[0]?.headers.get("authorization") ?? "";
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(`${CODE}:9999ZZ`);
    expect(unknown).toEqual([]);
  });

  it("falls back to the wide slot and clears it once delivered", async () => {
    const { fetchImpl } = fakeFetch({
      [DETAILS]: [
        {
          status: 200,
          body: payload("SHIPMENT_SORTED", {
            timeSlot: { low: "2026-11-19T08:00:00Z", high: "2026-11-19T20:00:00Z" },
          }),
        },
        { status: 200, body: payload("SHIPMENT_DELIVERED") },
      ],
    });
    const { base } = fakeContext(trunkrs.http, fetchImpl);
    const first = await plugin.track(base, config, null, [CODE]);
    expect(first.snapshots[0]).toMatchObject({ plannedFrom: "2026-11-19T08:00:00.000Z" });
    const second = await plugin.track(base, config, null, [CODE]);
    expect(second.snapshots[0]).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T14:05:00.000Z",
      plannedFrom: null,
      plannedTo: null,
    });
  });

  it("treats a refused number and postcode pair as not found", async () => {
    const { fetchImpl } = fakeFetch({ [DETAILS]: [{ status: 401, raw: "" }] });
    const { base } = fakeContext(trunkrs.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown state and keeps the raw value", async () => {
    const { fetchImpl } = fakeFetch({
      [DETAILS]: [{ status: 200, body: payload("SHIPMENT_MADE_UP") }],
    });
    const { base, unknown } = fakeContext(trunkrs.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: null, rawStatus: "SHIPMENT_MADE_UP" });
    expect(unknown).toContain("SHIPMENT_MADE_UP");
  });

  it("fails transiently on a server error or a network error", async () => {
    const { fetchImpl } = fakeFetch({
      [DETAILS]: [{ status: 502, raw: "" }, new Error("offline")],
    });
    const { base } = fakeContext(trunkrs.http, fetchImpl);
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
