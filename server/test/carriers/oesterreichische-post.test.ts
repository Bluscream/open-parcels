import { describe, expect, it } from "vitest";
import { oesterreichischePost } from "../../src/carriers/oesterreichische_post/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./nz-at-harness.js";

// Made-up codes and values only.
const CODE = "1000000000000000000001";

const event = (timestamp: string, trackingStateKey: string, textEn: string) => ({
  timestamp,
  trackingStateKey,
  textEn,
  text: "Beispiel",
  eventPlaceName: "Beispielort",
});

const shipment = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  data: {
    einzelsendung: {
      activeIdentityCode: CODE,
      status: "Anzeigetext",
      weight: 1.5,
      shipper: { name: "Beispielshop" },
      sendungsEvents: events,
      ...extra,
    },
  },
});

describe("Austrian Post tracking", () => {
  it("maps the newest event, reads the window in Vienna time and keeps the history", async () => {
    const { fetchImpl, calls } = scripted([
      {
        status: 200,
        body: shipment(
          [
            event("2026-11-16T10:00:00", "aviso", "Announced"),
            event("2026-11-18T07:00:00", "inDelivery", "Out for delivery"),
            event("2026-11-17T10:00:00", "inDistribution", "Sorted"),
          ],
          {
            estimatedDelivery: {
              startDate: "2026-11-18",
              startTime: "13:00",
              endDate: "2026-11-18",
              endTime: "15:00",
            },
          },
        ),
      },
    ]);
    const { registered, base, unknown } = harness(oesterreichischePost, fetchImpl);
    const out = await registered.track(base, { language: "en" }, null, [CODE]);
    expect(out.snapshots[0]).toMatchObject({
      carrier: "oesterreichische_post",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Anzeigetext",
      sender: "Beispielshop",
      weightKg: 1.5,
      // Vienna is UTC+1 in November.
      plannedFrom: "2026-11-18T12:00:00.000Z",
      plannedTo: "2026-11-18T14:00:00.000Z",
    });
    expect(out.snapshots[0]?.history.map((e) => [e.status, e.at])).toEqual([
      ["out_for_delivery", "2026-11-18T06:00:00.000Z"],
      ["in_transit", "2026-11-17T09:00:00.000Z"],
      ["registered", "2026-11-16T09:00:00.000Z"],
    ]);
    expect(new Headers(calls[0]?.init.headers).get("accept-language")).toBe("en");
    expect(unknown).toEqual([]);
  });

  it("reads a parcel left at the safe place as delivered", async () => {
    const { fetchImpl } = scripted([
      { status: 200, body: shipment([event("2026-11-18T10:00:00+01:00", "deliveryParked", "x")]) },
    ]);
    const { registered, base } = harness(oesterreichischePost, fetchImpl);
    const [parcel] = (await registered.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats a null shipment and a malformed-code rejection as not found", async () => {
    const { fetchImpl, calls } = scripted([
      { status: 200, body: { data: { einzelsendung: null } } },
      {
        status: 400,
        body: { errors: [{ extensions: { code: "INVALID_ARGUMENT_IDENTITY_CODE" } }] },
      },
    ]);
    const { registered, base } = harness(oesterreichischePost, fetchImpl);
    const out = await registered.track(base, {}, null, [CODE, CODE, "../x"]);
    expect(out.snapshots).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports an unknown state key", async () => {
    const { fetchImpl } = scripted([
      { status: 200, body: shipment([event("2026-11-18T10:00:00Z", "somethingNew", "x")]) },
    ]);
    const { registered, base, unknown } = harness(oesterreichischePost, fetchImpl);
    const [parcel] = (await registered.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("fails transiently on network errors, HTTP errors and GraphQL faults", async () => {
    const { fetchImpl } = scripted([
      new Error("offline"),
      { status: 500, body: {} },
      { status: 200, body: { errors: [{ message: "boom" }] } },
    ]);
    const { registered, base } = harness(oesterreichischePost, fetchImpl);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
