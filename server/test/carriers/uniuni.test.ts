import { describe, expect, it } from "vitest";
import { uniuni } from "../../src/carriers/uniuni/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, json, raw, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with an empty body. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => raw("", 404));

// Made-up values only.
const CODE = "UUS0000000000000001";
const TRACK = "GET delivery-api.uniuni.ca/cargo/trackinguniuninew";
const plugin = register(uniuni);

const at = (iso: string) => Date.parse(iso) / 1000;

function record(state: number, extra: Record<string, unknown> = {}) {
  return {
    tno: CODE,
    state,
    spath_list: [
      {
        state: 190,
        description_en: "Order received",
        dateTime: { ts: at("2026-11-15T10:00:00Z"), timezone: null },
      },
      {
        state: 200,
        description_en: "In transit",
        dateTime: { ts: at("2026-11-16T10:00:00Z"), timezone: "America/Toronto" },
      },
      {
        state,
        description_en: "Latest step",
        // No ts: only the local time and the zone name.
        dateTime: { localTime: "2026-11-18 09:30:00", timezone: "America/Toronto" },
      },
    ],
    ...extra,
  };
}

const answer = (records: unknown[]) =>
  json({ status: "SUCCESS", data: { valid_tno: records } }, 200);

describe("UniUni tracking", () => {
  it("reads the state, the history and anchors an event by its local time and zone", async () => {
    const { fetchImpl, calls } = network({ [TRACK]: [answer([record(202)])] });
    const { base, unknownKeys: unknown } = fakeContext(uniuni.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "uniuni",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      // UniUni's estimate endpoint has no confirmed shape, so no window is reported.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((event) => [event.at, event.status])).toEqual([
      ["2026-11-18T14:30:00.000Z", "out_for_delivery"],
      ["2026-11-16T10:00:00.000Z", "in_transit"],
      ["2026-11-15T10:00:00.000Z", "registered"],
    ]);
    expect(calls[0]?.url.searchParams.get("id")).toBe(CODE);
    expect(unknown).toEqual([]);
  });

  it("takes the delivery time from the delivered event", async () => {
    const { fetchImpl } = network({ [TRACK]: [answer([record(203)])] });
    const { base } = fakeContext(uniuni.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      delivered: true,
      deliveredAt: "2026-11-18T14:30:00.000Z",
    });
  });

  it("treats an empty record list as not found", async () => {
    const { fetchImpl } = network({ [TRACK]: [answer([])] });
    const { base } = fakeContext(uniuni.http, fetchImpl);
    expect(await plugin.track(base, {}, null, [CODE])).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown state", async () => {
    const { fetchImpl } = network({ [TRACK]: [answer([record(9999)])] });
    const { base, unknownKeys: unknown } = fakeContext(uniuni.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: null, rawStatus: "9999" });
    expect(unknown).toEqual(["9999"]);
  });

  it("stops on a refused key, a changed envelope or a network error", async () => {
    const { fetchImpl } = network({
      [TRACK]: [json({ msg: "invalid key" }, 400), json({ data: {} }, 200), new Error("offline")],
    });
    const { base } = fakeContext(uniuni.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
