import { describe, expect, it } from "vitest";
import { sunyou } from "../../src/carriers/sunyou/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, raw, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(sunyou);

// Made-up codes only.
const CODE = "SYTEST00000001";
const ROUTE = "GET www.sypost.net/queryTrack";

const item = (status: string, eventCode: string, createTime: string, timeZone = "+08:00") => ({
  status,
  eventCode,
  createTime,
  timeZone,
});

const jsonp = (entry: object): Answer =>
  raw(`searchCallback(${JSON.stringify({ data: [entry], message: "success", status: 1 })})`, 200);

const found = (items: unknown[]) =>
  jsonp({
    has: true,
    orderNo: CODE,
    trackingNumber: "LASTMILE0001",
    displayStatus: "3",
    result: { origin: { items } },
  });

describe("SunYou tracking", () => {
  it("reads the newest event with its own offset and keeps the history", async () => {
    const { fetchImpl, calls } = network({
      [ROUTE]: [
        found([
          item("101", "PreAlert", "2026-11-10 10:00:00"),
          item("2071", "OutForDelivery", "2026-11-18 08:00:00", "+01:00"),
          item("200", "InTransit", "2026-11-12 10:00:00"),
        ]),
      ],
    });
    const { base } = fakeContext(sunyou.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "sunyou",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "OutForDelivery",
      plannedFrom: null,
      plannedTo: null,
      url: `https://sypost.net/search?orderNo=${CODE}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T07:00:00.000Z", "out_for_delivery"],
      ["2026-11-12T02:00:00.000Z", "in_transit"],
      ["2026-11-10T02:00:00.000Z", "registered"],
    ]);
    expect(parcel?.raw).not.toHaveProperty("displayStatus");
    expect(calls[0]?.url.searchParams.get("trackNumber")).toBe(CODE);
  });

  it("treats has:false as not found", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [jsonp({ has: false, orderNo: CODE, displayStatus: "0" })],
    });
    const { base } = fakeContext(sunyou.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "a,b"])).snapshots).toEqual([]);
  });

  it("reports an unknown status code", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [found([item("999", "Mystery", "2026-11-18 08:00:00")])],
    });
    const { base, unknownKeys: unknown } = fakeContext(sunyou.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["999"]);
  });

  it("stops on a missing wrapper, an empty data list or a server error", async () => {
    const plain = fakeContext(sunyou.http, network({ [ROUTE]: [raw("oops", 200)] }).fetchImpl);
    await expect(plugin.track(plain.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const empty = fakeContext(
      sunyou.http,
      network({ [ROUTE]: [raw('searchCallback({"data":[]})', 200)] }).fetchImpl,
    );
    await expect(plugin.track(empty.base, {}, null, [CODE])).rejects.toThrow(/data entry/);
    const failing = fakeContext(sunyou.http, network({ [ROUTE]: [raw("", 502)] }).fetchImpl);
    await expect(plugin.track(failing.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
