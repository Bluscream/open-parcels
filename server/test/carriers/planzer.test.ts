import { describe, expect, it } from "vitest";
import { planzer } from "../../src/carriers/planzer/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeCarrier, trackingContext } from "./public-tracking-harness.js";

// Made-up codes and values only.
const CODE = "90000000000001";
const plugin = register(planzer);
const route = (code: string) => `GET /api/v1/shipments/${code}/Pak`;

function texts(german: string, english: string) {
  return { german, english, french: german, italian: german };
}

function event(sequenceOrder: number, createdAt: string, german: string, english: string) {
  return { sequenceOrder, createdAt, success: true, text: texts(german, english) };
}

function shipment(overall: unknown, events: unknown[], extra: Record<string, unknown> = {}) {
  return {
    shipmentNumber: CODE,
    overallStatus: overall,
    deliveryDay: { date: "2026-11-19T00:00:00", timeWindowSettings: {} },
    transportPositions: [{ weightGs: 2500, positionEvents: events }],
    ...extra,
  };
}

const EVENTS = [
  event(3, "2026-11-18T07:00:00.1234567", "In Zustellung", "Out for delivery"),
  event(1, "2026-11-17T09:00:00.001", "Erfasst", "Registered"),
  event(2, "2026-11-17T18:00:00", "Übergeben", "Handed over"),
];

describe("Planzer public tracking", () => {
  it("reads status, the whole-day window in Zurich time, weight and history", async () => {
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [{ status: 200, body: shipment(null, EVENTS) }],
    });
    const { base, unknown } = trackingContext(planzer, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "planzer",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Out for delivery",
      delivered: false,
      plannedFrom: "2026-11-18T23:00:00.000Z",
      plannedTo: "2026-11-19T22:59:59.000Z",
      weightKg: 2.5,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T06:00:00.123Z", "out_for_delivery"],
      ["2026-11-17T17:00:00.000Z", "in_transit"],
      ["2026-11-17T08:00:00.001Z", "registered"],
    ]);
    expect(parcel?.url).toContain(CODE);
    expect(unknown).toEqual([]);
  });

  it("narrows the window to a given time slot, in summer time too", async () => {
    const window = { start: "10:00", end: "12:00", secondStart: null, secondEnd: null };
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [
        {
          status: 200,
          body: shipment(null, EVENTS, {
            deliveryDay: { date: "2026-07-01", timeWindowSettings: window },
          }),
        },
      ],
    });
    const { base } = trackingContext(planzer, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      plannedFrom: "2026-07-01T08:00:00.000Z",
      plannedTo: "2026-07-01T10:00:00.000Z",
    });
  });

  it("takes delivery from the German overall text, never the English one", async () => {
    const overall = { text: texts("Sendung zugestellt", "Shipped"), color: 1 };
    const delivered = [...EVENTS, event(4, "2026-11-18T11:00:00", "Zugestellt", "Shipped")];
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [{ status: 200, body: shipment(overall, delivered) }],
    });
    const { base } = trackingContext(planzer, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T10:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats a 404 as not found", async () => {
    const { fetchImpl, calls } = fakeCarrier({ [route(CODE)]: [{ status: 404, body: "" }] });
    const { base } = trackingContext(planzer, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown text once and falls back to the newest event", async () => {
    const overall = { text: texts("Etwas Neues", "Something new"), color: 0 };
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [{ status: 200, body: shipment(overall, EVENTS) }],
    });
    const { base, unknown } = trackingContext(planzer, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBe("out_for_delivery");
    expect(unknown).toEqual(["etwas neues"]);
  });

  it("calls an unmapped text painted as danger a problem", async () => {
    const overall = { text: texts("Nicht zustellbar", "Undeliverable"), color: 3 };
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [{ status: 200, body: shipment(overall, EVENTS) }],
    });
    const { base } = trackingContext(planzer, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBe("problem");
  });

  it("raises transient errors for network failures, other statuses and bad bodies", async () => {
    const { fetchImpl } = fakeCarrier({
      [route(CODE)]: [new Error("offline"), { status: 401, body: "" }, { status: 200, body: [] }],
    });
    const { base } = trackingContext(planzer, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
