import { describe, expect, it } from "vitest";
import { speedx } from "../../src/carriers/speedx/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, raw, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(speedx);

// Made-up codes only.
const CODE = "SPXTEST0000000001";
const PAGE = `GET tracking.speedx.io/${CODE}`;
const API = "POST tracking.speedx.io/api/tracks";

const event = (eventCode: string, category: string, localTs: string, eventDescription = "") => ({
  eventCode,
  category,
  localTs,
  timeZone: "America/New_York",
  eventDescription,
});

/** A page whose flight chunk embeds the events, as the site serialises them. */
function page(events: unknown[]): Answer {
  const payload = `1:["$","div",null,{"tracking":{"events":${JSON.stringify(events)},"x":1}}]`;
  const push = JSON.stringify([1, payload]);
  return raw(
    `<html><script>self.__next_f.push([1,"0:[]"])</script><script>self.__next_f.push(${push})</script></html>`,
    200,
  );
}

describe("SpeedX tracking", () => {
  it("reads the history from the page and maps out-for-delivery by its text", async () => {
    const { fetchImpl, calls } = network({
      [PAGE]: [
        page([
          event("57110", "LAST_MILE_ENROUTE", "2026-11-18T08:00:00", "Out for delivery"),
          event("52001", "ORIGIN_HANDLING", "2026-11-17T10:00:00-05:00"),
          event("52001", "ORIGIN_HANDLING", "2026-11-17T10:00:00-05:00"),
          event("50001", "PICKUP", "2026-11-16T10:00:00"),
        ]),
      ],
    });
    const { base } = fakeContext(speedx.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "speedx",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "57110",
      plannedFrom: null,
      plannedTo: null,
      url: `https://tracking.speedx.io/${CODE}`,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T13:00:00.000Z", "out_for_delivery"],
      ["2026-11-17T15:00:00.000Z", "in_transit"],
      ["2026-11-16T15:00:00.000Z", "registered"],
    ]);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the current scan when the page has no history", async () => {
    const { fetchImpl } = network({
      [PAGE]: [page([])],
      [API]: [json([event("57201", "LAST_MILE_DELIVERED", "2026-11-18T12:00:00")], 200)],
    });
    const { base } = fakeContext(speedx.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-11-18T17:00:00.000Z" });
  });

  it("treats no history and no current scan as not found", async () => {
    const { fetchImpl } = network({ [PAGE]: [page([])], [API]: [json([], 200)] });
    const { base } = fakeContext(speedx.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports an unknown category", async () => {
    const { fetchImpl } = network({
      [PAGE]: [page([event("99999", "SOMETHING_NEW", "2026-11-18T08:00:00")])],
    });
    const { base, unknownKeys: unknown } = fakeContext(speedx.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("stops when the page lost its data or the server fails", async () => {
    const changed = fakeContext(
      speedx.http,
      network({
        [PAGE]: [raw("<html>new site</html>", 200)],
        [API]: [json([], 200)],
      }).fetchImpl,
    );
    await expect(plugin.track(changed.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const failing = fakeContext(speedx.http, network({ [PAGE]: [raw("", 500)] }).fetchImpl);
    await expect(plugin.track(failing.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
