import { describe, expect, it } from "vitest";
import { gls } from "../../src/carriers/gls/index.js";
import { register, type BaseContext } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

// Made-up codes, postcodes and names only.
const CODE = "99000000001";
const OTHER = "99000000002";
const plugin = register(gls);

type Reply = { status: number; body: unknown; html?: boolean } | Error;

/** Routes requests by host and the last path segment to scripted replies, used in order. */
function fake(routes: Record<string, Reply[]>) {
  const calls: URL[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    const segment = url.pathname.split("/").filter(Boolean);
    const key =
      url.hostname === "apm.gls.nl" ? `nl ${segment[3] ?? ""}` : segment.slice(-2).join("/");
    const reply = routes[key]?.shift() ?? { status: 204, body: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    if (reply.status === 204) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const body = reply.html === true ? "<html>Maintenance</html>" : JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status: reply.status }));
  };
  return { fetchImpl, calls };
}

function context(fetchImpl: FetchLike) {
  const clock = new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const unknown: string[] = [];
  const base: BaseContext = {
    sourceId: "s1",
    http: new PluginHttp(gls.http, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}

function nlParcel(state: number, extra: Record<string, unknown> = {}) {
  return {
    parcelNo: CODE,
    state,
    addressInfo: { from: { name: "Voorbeeldwinkel" }, to: { name: "Testpersoon" } },
    deliveryStatus: {
      etaTimestampMin: "2026-11-19T09:00:00+01:00",
      etaTimestampMax: "2026-11-19T13:00:00+01:00",
    },
    parcels: [{ lastStatus: "Onderweg" }],
    weighedWeight: 1.5,
    scans: [
      { dateTime: "2026-11-17T10:00:00+01:00", state: 0, eventReasonDescr: "Aangekondigd" },
      { dateTime: "2026-11-18T08:00:00+01:00", state: 2, eventReasonDescr: "Op depot" },
    ],
    ...extra,
  };
}

function groupParcel(statusInfo: string) {
  return {
    tuNo: "11111111",
    progressBar: { statusInfo, statusText: "Delivered" },
    infos: [{ type: "WEIGHT", value: "0,9 kg" }],
    history: [
      {
        date: "2026-11-18",
        time: "09:30:00",
        evtNo: "3.896",
        evtDscr: "In the ParcelLocker &amp; ready",
        address: { city: "Testdorf" },
      },
      { date: "2026-11-17", time: "07:00:00", evtNo: "2.0", evtDscr: "Parcel center" },
    ],
  };
}

const nlConfig = { country: "NL", postalCode: "1234 AB" };
const czConfig = { country: "CZ", postalCode: "123 45" };

describe("gls Netherlands", () => {
  it("reads a found parcel with status, window and history", async () => {
    const { fetchImpl, calls } = fake({ [`nl ${CODE}`]: [{ status: 200, body: nlParcel(2) }] });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, nlConfig, null, [CODE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      barcode: CODE,
      status: "in_transit",
      rawStatus: "Onderweg",
      delivered: false,
      plannedFrom: "2026-11-19T08:00:00.000Z",
      plannedTo: "2026-11-19T12:00:00.000Z",
      sender: "Voorbeeldwinkel",
      weightKg: 1.5,
    });
    expect(parcel?.history.map((e) => [e.status, e.rawStatus])).toEqual([
      ["in_transit", "Op depot"],
      ["registered", "Aangekondigd"],
    ]);
    expect(calls[0]?.pathname).toContain("/postalcode/1234AB/details/nl-NL");
    expect(unknown).toEqual([]);
  });

  it("reports nothing for an unknown parcel", async () => {
    const { fetchImpl } = fake({});
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, nlConfig, null, [CODE]);
    expect(result).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unmapped state", async () => {
    const { fetchImpl } = fake({ [`nl ${CODE}`]: [{ status: 200, body: nlParcel(9) }] });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, nlConfig, null, [CODE]);
    expect(result.snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["state:9"]);
  });

  it("stops on a network error and on a page that is not JSON", async () => {
    const down = fake({ [`nl ${CODE}`]: [new Error("offline")] });
    await expect(
      plugin.track(context(down.fetchImpl).base, nlConfig, null, [CODE, OTHER]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(down.calls).toHaveLength(1);
    const html = fake({ [`nl ${CODE}`]: [{ status: 200, body: null, html: true }] });
    await expect(
      plugin.track(context(html.fetchImpl).base, nlConfig, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe("gls group countries", () => {
  it("reads a parcel waiting in a locker, with history in local time", async () => {
    const { fetchImpl, calls } = fake({
      [`rstt028/${CODE}`]: [{ status: 200, body: groupParcel("DELIVEREDPS") }],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, czConfig, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      barcode: CODE,
      status: "at_pickup_point",
      pickup: true,
      delivered: false,
      rawStatus: "In the ParcelLocker & ready",
      weightKg: 0.9,
    });
    expect(result.snapshots[0]?.history[0]).toEqual({
      at: "2026-11-18T08:30:00.000Z",
      status: "at_pickup_point",
      rawStatus: "In the ParcelLocker & ready",
      location: "Testdorf",
    });
    expect(calls[0]?.searchParams.get("postalCode")).toBe("12345");
  });

  it("falls back to the overview on a postcode mismatch, retrying the lookup type", async () => {
    const { fetchImpl, calls } = fake({
      [`rstt028/${CODE}`]: [{ status: 404, body: { lastError: "E609" } }],
      "en/rstt029": [
        { status: 500, body: {} },
        { status: 200, body: { tuStatus: [{ progressBar: { statusInfo: "DELIVERED" } }] } },
      ],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, czConfig, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: "delivered", delivered: true });
    expect(calls.map((c) => c.searchParams.get("type"))).toEqual([null, "", "NAT"]);
  });

  it("treats a malformed reference as not found and stops on the maintenance page", async () => {
    const missing = fake({ [`rstt028/${CODE}`]: [{ status: 404, body: { lastError: "E206" } }] });
    expect(
      (await plugin.track(context(missing.fetchImpl).base, czConfig, null, [CODE])).snapshots,
    ).toEqual([]);
    const down = fake({ [`rstt028/${CODE}`]: [{ status: 200, body: null, html: true }] });
    await expect(
      plugin.track(context(down.fetchImpl).base, czConfig, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("reports an unmapped status and honours the return flag", async () => {
    const body = { progressBar: { statusInfo: "NEWSTATE", retourFlag: true } };
    const { fetchImpl } = fake({ [`rstt028/${CODE}`]: [{ status: 200, body }] });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, czConfig, null, [CODE]);
    expect(result.snapshots[0]?.status).toBe("returning");
    expect(unknown).toEqual(["NEWSTATE"]);
  });

  it("rejects a configuration without a supported country", () => {
    expect(() => {
      plugin.validateConfig({ country: "DE", postalCode: "12345" });
    }).toThrow();
  });
});
