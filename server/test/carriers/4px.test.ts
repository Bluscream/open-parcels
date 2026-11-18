import { describe, expect, it } from "vitest";
import { fourPx } from "../../src/carriers/4px/index.js";
import { RateLimitedError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "4PX0000000000001TEST";
const ROUTE = "POST track.4px.com/track/v2/front/listTrackV3";

function track(tkCode: string, tkDate: string) {
  return { tkCode, tkDate, tkDateStr: tkDate, tkTimezone: "UTC+08:00" };
}

function found(latest: string) {
  return {
    result: 1,
    data: [
      {
        serverCode: CODE,
        tracks: [
          track(latest, "2026-11-18T09:00:00+08:00"),
          track("FPX_M_IT", "2026-11-16T10:00:00+08:00"),
          track("FPX_O_IR", "2026-11-15T10:00:00+08:00"),
        ],
      },
    ],
  };
}

describe("4PX tracking", () => {
  it("maps the newest event, lists history newest first and has no window", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json(found("FPX_D_SD")))];
    const result = await w.track([CODE]);
    expect(result.complete).toBe(true);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "4px",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "FPX_D_SD",
      delivered: false,
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.url).toContain(CODE);
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T01:00:00.000Z", "out_for_delivery"],
      ["2026-11-16T02:00:00.000Z", "in_transit"],
      ["2026-11-15T02:00:00.000Z", "registered"],
    ]);
    expect(JSON.parse(w.calls[0]?.body ?? "{}")).toMatchObject({ queryCodes: [CODE] });
  });

  it("marks a delivered parcel with its delivery time", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json(found("FPX_S_OK")))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T01:00:00.000Z",
    });
  });

  it("leaves a code 4PX does not know out of the result", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json({ result: 1, data: [{ serverCode: null, tracks: null }] }))];
    const result = await w.track([CODE]);
    expect(result).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unmapped event code and keeps the status unknown", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json(found("FPX_X_NEW")))];
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_code:FPX_X_NEW"]);
  });

  it("stops on an envelope it does not recognise", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json({ result: 0, data: [] }))];
    await expect(w.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("passes a rate limit on and sends nothing for implausible codes", async () => {
    const w = new World(fourPx);
    w.routes = [on(ROUTE, json({}, 429, { "retry-after": "60" }))];
    await expect(w.track(["no spaces allowed", CODE])).rejects.toBeInstanceOf(RateLimitedError);
    expect(w.calls).toHaveLength(1);
  });
});
