import { describe, expect, it } from "vitest";
import { oesterreichischePost } from "../../src/carriers/oesterreichische_post/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import type { CarrierPlugin } from "../../src/plugin/api.js";
import type { FetchLike } from "../../src/plugin/http.js";
import { fakeContext, fakeNetwork, inOrder, json, type Answer } from "./harness.js";

/** Replies in order; once they run out, 500 with an empty JSON object. */
const scripted = (replies: Answer[]) => fakeNetwork([inOrder(...replies)], () => json({}, 500));

function harness<C, S>(plugin: CarrierPlugin<C, S>, fetchImpl: FetchLike) {
  const { base, unknownKeys } = fakeContext(plugin.http, fetchImpl);
  return { registered: register(plugin), base, unknown: unknownKeys };
}

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
      json(
        shipment(
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
        200,
      ),
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
      json(shipment([event("2026-11-18T10:00:00+01:00", "deliveryParked", "x")]), 200),
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
      json({ data: { einzelsendung: null } }, 200),
      json({ errors: [{ extensions: { code: "INVALID_ARGUMENT_IDENTITY_CODE" } }] }, 400),
    ]);
    const { registered, base } = harness(oesterreichischePost, fetchImpl);
    const out = await registered.track(base, {}, null, [CODE, CODE, "../x"]);
    expect(out.snapshots).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports an unknown state key", async () => {
    const { fetchImpl } = scripted([
      json(shipment([event("2026-11-18T10:00:00Z", "somethingNew", "x")]), 200),
    ]);
    const { registered, base, unknown } = harness(oesterreichischePost, fetchImpl);
    const [parcel] = (await registered.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("fails transiently on network errors, HTTP errors and GraphQL faults", async () => {
    const { fetchImpl } = scripted([
      new Error("offline"),
      json({}, 500),
      json({ errors: [{ message: "boom" }] }, 200),
    ]);
    const { registered, base } = harness(oesterreichischePost, fetchImpl);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
