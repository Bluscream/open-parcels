import { describe, expect, it } from "vitest";
import { packeta } from "../../src/carriers/packeta/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, raw, type Answer } from "./harness.js";

const JSON_TYPE = { "content-type": "application/json" };
const ok = (body: string) => raw(body, 200, JSON_TYPE);
/** Replies in order; once they run out, 404 with an empty body. */
const scripted = (replies: Answer[]) =>
  fakeNetwork([inOrder(...replies)], () => raw("", 404, JSON_TYPE));

// Made-up codes and values only.
const CODE = "Z0000000001";
const plugin = register(packeta);

function item(statusId: string, details: { text: string; time: string }[]) {
  return JSON.stringify({
    item: {
      barcode: CODE,
      packetStatusId: statusId,
      packetStatus: "Status text",
      sender: "Example Shop",
      branchAddress: "Example pickup point",
      trackingDetails: details,
    },
  });
}

const HISTORY = [
  {
    text: "We are aware of your parcel and are waiting for the sender.",
    time: "2026-07-01 10:00:00",
  },
  { text: "The parcel has arrived at the depot.", time: "2026-07-02 08:30:00" },
  { text: "The parcel is ready for pickup.", time: "2026-07-03 12:00:00" },
];

describe("Packeta public tracking", () => {
  it("maps the status id, reads the pickup point and history in Prague time", async () => {
    const { fetchImpl, calls } = scripted([ok(item("2", HISTORY))]);
    const { base } = fakeContext(packeta.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "packeta",
      barcode: CODE,
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Example pickup point",
      plannedFrom: null,
      plannedTo: null,
      sender: "Example Shop",
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-07-03T10:00:00.000Z", "at_pickup_point"],
      ["2026-07-02T06:30:00.000Z", "in_transit"],
      ["2026-07-01T08:00:00.000Z", "registered"],
    ]);
    expect(calls[0]?.method).toBe("POST");
  });

  it("takes the newest event as the delivery time", async () => {
    const delivered = [
      ...HISTORY,
      { text: "The parcel is with you.", time: "2026-01-05 14:00:00" },
    ];
    const { fetchImpl } = scripted([ok(item("3", delivered))]);
    const { base } = fakeContext(packeta.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-07-03T10:00:00.000Z" });
  });

  it("treats a 404 and an error body as not found", async () => {
    const { fetchImpl } = scripted([
      raw(JSON.stringify({ error: "notFound" }), 404, JSON_TYPE),
      ok(JSON.stringify({ error: "notFound" })),
    ]);
    const { base } = fakeContext(packeta.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, CODE])).snapshots).toEqual([]);
  });

  it("fails on an error that does not say not found, instead of dropping the code", async () => {
    const { fetchImpl } = scripted([ok(JSON.stringify({ error: "internalError" }))]);
    const { base } = fakeContext(packeta.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toThrow(/error/u);
  });

  it("files the answer under the tracked code, keeping Packeta's spelling as a reference", async () => {
    const echoed = JSON.parse(item("2", HISTORY)) as { item: Record<string, unknown> };
    echoed.item["barcode"] = "Z 000 000 0001";
    const { fetchImpl } = scripted([ok(JSON.stringify(echoed))]);
    const { base } = fakeContext(packeta.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ barcode: CODE, externalRef: "Z 000 000 0001" });
  });

  it("reports unknown status ids and event texts", async () => {
    const odd = [{ text: "Something new happened.", time: "2026-07-01 10:00:00" }];
    const { fetchImpl } = scripted([ok(item("4242", odd))]);
    const { base, reports: unknown } = fakeContext(packeta.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual([
      { kind: "status_code", key: "4242" },
      { kind: "event_text", key: "Something new happened." },
    ]);
  });

  it("fails transiently on network errors and server errors", async () => {
    for (const reply of [new Error("offline"), raw("", 500, JSON_TYPE)]) {
      const { fetchImpl } = scripted([reply]);
      await expect(
        plugin.track(fakeContext(packeta.http, fetchImpl).base, {}, null, [CODE]),
      ).rejects.toBeInstanceOf(TransientError);
    }
  });
});
