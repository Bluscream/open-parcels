import { describe, expect, it } from "vitest";
import { vintedGo } from "../../src/carriers/vinted_go/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, json, raw, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with an empty body. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => raw("", 404));

// Made-up values only.
const CODE = "VGO00000000001";
const EVENTS = `GET carrier.vintedgo.com/members/public/v1/tracking_events/${CODE}`;
const plugin = register(vintedGo);

const event = (group: string, timestamp: string, message: string) => ({
  group,
  timestamp,
  message,
  state: "delivery",
});

const timeline = (...latest: ReturnType<typeof event>[]) =>
  json(
    {
      tracking_events: [
        event("created", "2026-11-15T10:00:00Z", "Label created"),
        event("in_transit", "2026-11-16T10:00:00Z", "On its way"),
        ...latest,
      ],
      meta: {},
    },
    200,
  );

describe("Vinted Go tracking", () => {
  it("reads the newest group, the pickup state and the history", async () => {
    const { fetchImpl } = network({
      [EVENTS]: [
        timeline(event("ready_for_pickup", "2026-11-18T09:00:00Z", "Ready at the locker")),
      ],
    });
    const { base, unknownKeys: unknown } = fakeContext(vintedGo.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "vinted_go",
      barcode: CODE,
      status: "at_pickup_point",
      rawStatus: "Ready at the locker",
      pickup: true,
      // The public timeline has no delivery window.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((entry) => entry.status)).toEqual([
      "at_pickup_point",
      "in_transit",
      "registered",
    ]);
    expect(unknown).toEqual([]);
  });

  it("reads a delivery with its time", async () => {
    const { fetchImpl } = network({
      [EVENTS]: [timeline(event("delivered", "2026-11-18T12:00:00Z", "Collected"))],
    });
    const { base } = fakeContext(vintedGo.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      delivered: true,
      deliveredAt: "2026-11-18T12:00:00.000Z",
    });
  });

  it("treats a 404 as not found", async () => {
    const { fetchImpl } = network({
      [EVENTS]: [json({ error_code: "not_found" }, 404)],
    });
    const { base } = fakeContext(vintedGo.http, fetchImpl);
    expect(await plugin.track(base, {}, null, [CODE])).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown group", async () => {
    const { fetchImpl } = network({
      [EVENTS]: [timeline(event("made_up_group", "2026-11-18T09:00:00Z", "Something new"))],
    });
    const { base, unknownKeys: unknown } = fakeContext(vintedGo.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: null, rawStatus: "Something new" });
    expect(unknown).toEqual(["made_up_group"]);
  });

  it("stops on a changed body, a server error or a network error", async () => {
    const { fetchImpl } = network({
      [EVENTS]: [json([], 200), raw("", 500), new Error("offline")],
    });
    const { base } = fakeContext(vintedGo.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
