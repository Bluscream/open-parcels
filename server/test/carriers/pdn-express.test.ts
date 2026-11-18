import { describe, expect, it } from "vitest";
import { pdnExpress } from "../../src/carriers/pdn_express/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeCarrier, trackingContext } from "./public-tracking-harness.js";

// Made-up codes and values only.
const CODE = "PDN000000000001";
const OTHER = "PDN000000000002";
const plugin = register(pdnExpress);
const ROUTE = "POST /api/track";

function event(eventCode: string, eventTime: string, eventDesc: string) {
  return { eventCode, eventTime, utcTimezone: "UTC+2", eventDesc, eventLocation: "Testhub" };
}

function found(orderNo: string, events: unknown[]) {
  return { status: 200, body: { ok: true, data: [{ orderNo, events }] } };
}

describe("PDN Express public tracking", () => {
  it("maps the newest mappable event and keeps the history newest first", async () => {
    const { fetchImpl, calls } = fakeCarrier({
      [ROUTE]: [
        found(CODE, [
          event("D810", "2026-11-18 11:00:00", "Customer service note"),
          event("D840", "2026-11-18 08:00:00", "Out for delivery"),
          event("D830", "2026-11-17 10:00:00", "In transit"),
          event("D800", "2026-11-16 09:00:00", "Order created"),
        ]),
      ],
    });
    const { base } = trackingContext(pdnExpress, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "pdn_express",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Out for delivery",
      delivered: false,
      // The carrier publishes no delivery window.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T09:00:00.000Z", null],
      ["2026-11-18T06:00:00.000Z", "out_for_delivery"],
      ["2026-11-17T08:00:00.000Z", "in_transit"],
      ["2026-11-16T07:00:00.000Z", "registered"],
    ]);
    expect(parcel?.url).toContain(CODE);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ orderNos: CODE });
  });

  it("marks a delivered parcel with its delivery time", async () => {
    const { fetchImpl } = fakeCarrier({
      [ROUTE]: [found(CODE, [event("D860", "2026-11-18 12:30:00", "Delivered")])],
    });
    const { base } = trackingContext(pdnExpress, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-11-18T10:30:00.000Z" });
  });

  it("treats an event-less notice and an answer for another code as not found", async () => {
    const notice = { lanName: "Sorry, your tracking attempt was not successful." };
    const { fetchImpl } = fakeCarrier({
      [ROUTE]: [
        { status: 200, body: { ok: true, data: [{ orderNo: CODE, statusCodeConfig: notice }] } },
        found(CODE, [event("D800", "2026-11-16 09:00:00", "Order created")]),
      ],
    });
    const { base } = trackingContext(pdnExpress, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, OTHER, "../x"]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unknown event code and keeps the status null", async () => {
    const { fetchImpl } = fakeCarrier({
      [ROUTE]: [found(CODE, [event("D999", "2026-11-18 08:00:00", "Something new")])],
    });
    const { base, unknown } = trackingContext(pdnExpress, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["D999"]);
  });

  it("raises transient errors for network failures and the upstream envelope", async () => {
    const { fetchImpl } = fakeCarrier({
      [ROUTE]: [new Error("offline"), { status: 200, body: { ok: false, error: "upstream" } }],
    });
    const { base } = trackingContext(pdnExpress, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });

  it("stops on an unfamiliar failure envelope or a non-object body", async () => {
    const { fetchImpl } = fakeCarrier({
      [ROUTE]: [
        { status: 200, body: { ok: false, error: "changed" } },
        { status: 200, body: [] },
      ],
    });
    const { base } = trackingContext(pdnExpress, fetchImpl);
    for (let i = 0; i < 2; i += 1) {
      await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
    }
  });
});
