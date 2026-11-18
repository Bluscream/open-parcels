import { describe, expect, it } from "vitest";
import { nzPost } from "../../src/carriers/nz_post/index.js";
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
const CODE = "TS000000001NZ";

const step = (date_time: string, status: string | null, edifact_code = "0") => ({
  date_time,
  status,
  edifact_code,
  description: "Beispiel",
});

const result = (events: unknown[]) => ({
  status_code: 0,
  results: [{ tracking_reference: CODE, tracking_events: events }],
});

describe("NZ Post tracking", () => {
  it("maps the newest event and keeps the history newest first", async () => {
    const { fetchImpl, calls } = scripted([
      json(
        result([
          step("2026-11-18T08:00:00+13:00", "With courier for delivery"),
          step("2026-11-16T10:00:00+13:00", "Label created"),
          step("2026-11-17T10:00:00+13:00", null, "5000"),
        ]),
        200,
      ),
    ]);
    const { registered, base, unknown } = harness(nzPost, fetchImpl);
    const out = await registered.track(base, {}, null, [CODE]);
    expect(out.complete).toBe(true);
    expect(out.snapshots[0]).toMatchObject({
      carrier: "nz_post",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "With courier for delivery",
      delivered: false,
      // The public tracking never gives a delivery window.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(out.snapshots[0]?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(out.snapshots[0]?.url).toContain(CODE);
    expect(calls[0]?.url.searchParams.get("tracking_reference")).toBe(CODE);
    expect(unknown).toEqual([]);
  });

  it("reads delivered with its time", async () => {
    const { fetchImpl } = scripted([
      json(result([step("2026-11-18T09:00:00Z", "Delivered")]), 200),
    ]);
    const { registered, base } = harness(nzPost, fetchImpl);
    const [parcel] = (await registered.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-11-18T09:00:00.000Z" });
  });

  it("treats status_code 2, empty results and result errors as not found", async () => {
    const { fetchImpl, calls } = scripted([
      json({ status_code: 2 }, 200),
      json({ results: [] }, 200),
      json({ results: [{ errors: [{ message: "x" }] }] }, 200),
    ]);
    const { registered, base } = harness(nzPost, fetchImpl);
    const out = await registered.track(base, {}, null, [CODE, CODE, CODE, "../x"]);
    expect(out.snapshots).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("reports an unknown status once and leaves it unmapped", async () => {
    const { fetchImpl } = scripted([
      json(
        result([
          step("2026-11-18T08:00:00Z", "Something new"),
          step("2026-11-17T08:00:00Z", "Something new"),
        ]),
        200,
      ),
    ]);
    const { registered, base, unknown } = harness(nzPost, fetchImpl);
    const [parcel] = (await registered.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["Something new"]);
  });

  it("fails transiently on network errors, HTTP errors and wrong shapes", async () => {
    const { fetchImpl } = scripted([new Error("offline"), json({}, 502), json([], 200)]);
    const { registered, base } = harness(nzPost, fetchImpl);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(registered.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
