import { describe, expect, it } from "vitest";
import { delhivery } from "../../src/carriers/delhivery/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness.js";

// Made-up waybills and values only.
const CODE = "9900000000001";
const ROUTE = "GET dlv-api.delhivery.com/v3/unified-tracking-new";
const plugin = register(delhivery);

function parcel(hqStatus: string | null, extra: Record<string, unknown> = {}) {
  return {
    awb: CODE,
    hqStatus,
    clientName: "Example Shop",
    consignee: "Test Person",
    PromiseDeliveryDate: "2026-11-20T00:00:00",
    trackingStates: [
      {
        label: "Picked Up",
        scans: [{ scanDateTime: "2026-11-16T09:30:00", scanNslRemark: "Shipment picked up" }],
      },
      {
        label: "On the Way",
        scans: [
          {
            scanDateTime: "2026-11-17T14:00:00",
            scanNslRemark: "Reached hub",
            cityLocation: "Hub A",
          },
        ],
      },
    ],
    ...extra,
  };
}

describe("Delhivery tracking", () => {
  it("maps hqStatus, reads the promised date in Indian time and builds the history", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [{ status: 200, body: { statusCode: 200, data: [parcel("In Transit")] } }],
    });
    const { base, unknown } = harness(delhivery.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(calls[0]?.headers.get("origin")).toBe("https://www.delhivery.com");
    expect(calls[0]?.url.searchParams.get("wbn")).toBe(CODE);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "delhivery",
      barcode: CODE,
      status: "in_transit",
      rawStatus: "In Transit",
      plannedFrom: "2026-11-19T18:30:00.000Z",
      sender: "Example Shop",
      delivered: false,
    });
    expect(result.snapshots[0]?.history).toEqual([
      {
        at: "2026-11-17T08:30:00.000Z",
        status: "in_transit",
        rawStatus: "Reached hub",
        location: "Hub A",
      },
      {
        at: "2026-11-16T04:00:00.000Z",
        status: "in_transit",
        rawStatus: "Shipment picked up",
        location: null,
      },
    ]);
    expect(unknown).toEqual([]);
  });

  it("falls back to the ladder and takes the delivery time from the status block", async () => {
    const delivered = parcel(null, {
      currentTrackIndex: 2,
      trackingStates: [...parcel(null).trackingStates, { label: "Delivered", scans: [] }],
      status: { statusDateTime: "2026-11-18T11:00:00" },
    });
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 200, body: { data: [delivered] } }] });
    const { base } = harness(delhivery.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T05:30:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats an empty data list as not found and never sends implausible codes", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [{ status: 200, body: { statusCode: 200, message: "invalid", data: [] } }],
    });
    const { base } = harness(delhivery.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, "not a code"]);
    expect(result).toEqual({ snapshots: [], complete: true });
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown status once and leaves the status empty", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [{ status: 200, body: { data: [parcel("Teleported")] } }],
    });
    const { base, unknown } = harness(delhivery.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found).toMatchObject({ status: null, rawStatus: "Teleported" });
    expect(unknown).toEqual(["status:Teleported"]);
  });

  it("fails transiently on a refused request instead of reporting the parcel gone", async () => {
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 401, body: {} }] });
    const { base } = harness(delhivery.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
