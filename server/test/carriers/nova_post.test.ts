import { describe, expect, it } from "vitest";
import { novaPost } from "../../src/carriers/nova_post/index.js";
import { register, type BaseContext } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

// Made-up codes and values only.
const ACTIVE = "20400000000001";
const DELIVERED = "20400000000002";
const plugin = register(novaPost);

function hop(code: string, date: string, eventName: string, division = "Testviddilennia 1") {
  return { code, date, event_name: eventName, division_name: division };
}

function payload(
  code: string,
  latest: ReturnType<typeof hop>,
  extra: Record<string, unknown> = {},
) {
  return {
    number: code,
    sender: { country_code: "XX" },
    recipient: { settlement: "Testmisto", country_code: "UA" },
    scheduled_delivery_date: "2026-11-19 12:00:00",
    total_weight: 0.5,
    tracking: [
      hop("1", "2026-11-16 10:00:00", "Gotovo do vidpravlennia"),
      hop("5", "2026-11-17 10:00:00", "Vidpravleno"),
      latest,
    ],
    ...extra,
  };
}

type Reply = { status: number; body: unknown } | Error;

function fakeApi(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    const code = url.pathname.split("/").at(-1) ?? "";
    calls.push(code);
    const reply = routes[code]?.shift() ?? { status: 404, body: { errorMessage: "not_found" } };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
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
    http: new PluginHttp(novaPost.http, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}

describe("Nova Post tracking", () => {
  it("maps the newest hop and reads the estimate, weight, places and history", async () => {
    const { fetchImpl } = fakeApi({
      [ACTIVE]: [
        { status: 200, body: payload(ACTIVE, hop("7", "2026-11-18 08:00:00", "Prybulo")) },
      ],
    });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE]);
    const [parcel] = result.snapshots;
    expect(result.complete).toBe(true);
    expect(parcel).toMatchObject({
      carrier: "nova_post",
      barcode: ACTIVE,
      status: "at_pickup_point",
      rawStatus: "Prybulo",
      pickup: true,
      pickupPoint: "Testviddilennia 1",
      plannedFrom: "2026-11-19T12:00:00.000Z",
      plannedTo: "2026-11-19T12:00:00.000Z",
      sender: "XX",
      receiver: "Testmisto, UA",
      weightKg: 0.5,
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "at_pickup_point",
      "in_transit",
      "registered",
    ]);
    expect(parcel?.url).toContain(ACTIVE);
    expect(unknown).toEqual([]);
  });

  it("takes the delivery time from the newest received hop", async () => {
    const { fetchImpl } = fakeApi({
      [DELIVERED]: [
        { status: 200, body: payload(DELIVERED, hop("9", "2026-11-18 09:30:00", "Otrymano")) },
      ],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [DELIVERED])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:30:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats 404 as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeApi({});
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toEqual([ACTIVE]);
  });

  it("reports an unmapped code and keeps the status open", async () => {
    const { fetchImpl } = fakeApi({
      [ACTIVE]: [{ status: 200, body: payload(ACTIVE, hop("777", "2026-11-18 08:00:00", "Nove")) }],
    });
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [ACTIVE])).snapshots;
    expect(parcel).toMatchObject({ status: null, rawStatus: "Nove", delivered: false });
    expect(unknown).toEqual(["777"]);
  });

  it("fails on a network error, a server error or the wrong shape", async () => {
    const network = fakeApi({ [ACTIVE]: [new Error("socket hang up")] });
    await expect(
      plugin.track(context(network.fetchImpl).base, {}, null, [ACTIVE, DELIVERED]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(network.calls).toEqual([ACTIVE]);

    const server = fakeApi({ [ACTIVE]: [{ status: 502, body: {} }] });
    await expect(
      plugin.track(context(server.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(TransientError);

    const shape = fakeApi({ [ACTIVE]: [{ status: 200, body: [1, 2] }] });
    await expect(
      plugin.track(context(shape.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
