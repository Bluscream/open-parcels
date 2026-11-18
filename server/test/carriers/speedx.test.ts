import { describe, expect, it } from "vitest";
import { speedx } from "../../src/carriers/speedx/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeRoutes, harness, type Reply } from "./route-harness.js";

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
function page(events: unknown[]): Reply {
  const payload = `1:["$","div",null,{"tracking":{"events":${JSON.stringify(events)},"x":1}}]`;
  const push = JSON.stringify([1, payload]);
  return {
    status: 200,
    contentType: "text/html",
    body: `<html><script>self.__next_f.push([1,"0:[]"])</script><script>self.__next_f.push(${push})</script></html>`,
  };
}

describe("SpeedX tracking", () => {
  it("reads the history from the page and maps out-for-delivery by its text", async () => {
    const { fetchImpl, calls } = fakeRoutes({
      [PAGE]: [
        page([
          event("57110", "LAST_MILE_ENROUTE", "2026-11-18T08:00:00", "Out for delivery"),
          event("52001", "ORIGIN_HANDLING", "2026-11-17T10:00:00-05:00"),
          event("52001", "ORIGIN_HANDLING", "2026-11-17T10:00:00-05:00"),
          event("50001", "PICKUP", "2026-11-16T10:00:00"),
        ]),
      ],
    });
    const { plugin, base } = harness(speedx, fetchImpl);
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
    const { fetchImpl } = fakeRoutes({
      [PAGE]: [page([])],
      [API]: [
        { status: 200, body: [event("57201", "LAST_MILE_DELIVERED", "2026-11-18T12:00:00")] },
      ],
    });
    const { plugin, base } = harness(speedx, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-11-18T17:00:00.000Z" });
  });

  it("treats no history and no current scan as not found", async () => {
    const { fetchImpl } = fakeRoutes({ [PAGE]: [page([])], [API]: [{ status: 200, body: [] }] });
    const { plugin, base } = harness(speedx, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports an unknown category", async () => {
    const { fetchImpl } = fakeRoutes({
      [PAGE]: [page([event("99999", "SOMETHING_NEW", "2026-11-18T08:00:00")])],
    });
    const { plugin, base, unknown } = harness(speedx, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("stops when the page lost its data or the server fails", async () => {
    const changed = harness(
      speedx,
      fakeRoutes({
        [PAGE]: [{ status: 200, body: "<html>new site</html>", contentType: "text/html" }],
        [API]: [{ status: 200, body: [] }],
      }).fetchImpl,
    );
    await expect(changed.plugin.track(changed.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const failing = harness(speedx, fakeRoutes({ [PAGE]: [{ status: 500, body: "" }] }).fetchImpl);
    await expect(failing.plugin.track(failing.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
