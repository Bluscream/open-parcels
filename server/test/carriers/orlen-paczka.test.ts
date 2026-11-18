import { describe, expect, it } from "vitest";
import { orlenPaczka } from "../../src/carriers/orlen_paczka/index.js";
import { register, type BaseContext } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

// Made-up codes and values only.
const ACTIVE = "9000000000000001";
const PICKUP = "9000000000000002";
const MISSING = "9000000000000003";

const plugin = register(orlenPaczka);

type Reply = { status: number; body: string } | Error;

const jsonp = (payload: unknown) => `callback(${JSON.stringify(payload)});`;

function fakeOrlen(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    const code = url.searchParams.get("id") ?? "";
    calls.push(code);
    const reply = routes[code]?.shift() ?? { status: 200, body: jsonp({ status: "" }) };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
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
    http: new PluginHttp(orlenPaczka.http, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}

function answer(code: string, history: [string | number, string, string][]) {
  return jsonp({
    status: "OK",
    number: code,
    historyHtml: "<li>markup</li>",
    history: history.map(([eventCode, date, label]) => ({ code: eventCode, date, label })),
  });
}

describe("ORLEN Paczka public tracking", () => {
  it("maps the latest event, converts Warsaw time and keeps the history", async () => {
    const { fetchImpl } = fakeOrlen({
      [ACTIVE]: [
        {
          status: 200,
          body: answer(ACTIVE, [
            [200, "16-11-2026, 10:00", "Nadana"],
            ["300", "17-07-2026, 10:00", "W drodze"],
            ["1000", "18-11-2026, 09:30", "Doręczona"],
          ]),
        },
      ],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [ACTIVE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "orlen_paczka",
      barcode: ACTIVE,
      status: "delivered",
      rawStatus: "Doręczona",
      delivered: true,
      // November is CET (UTC+1).
      deliveredAt: "2026-11-18T08:30:00.000Z",
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T08:30:00.000Z", "delivered"],
      ["2026-11-16T09:00:00.000Z", "registered"],
      // July is CEST (UTC+2).
      ["2026-07-17T08:00:00.000Z", "in_transit"],
    ]);
    expect(JSON.stringify(parcel?.raw)).not.toContain("markup");
  });

  it("tells a pickup point from a hand-off abroad for code 690", async () => {
    const { fetchImpl } = fakeOrlen({
      [PICKUP]: [
        {
          status: 200,
          body: answer(PICKUP, [["690", "18-11-2026, 08:00", "Czeka na odbiór w punkcie"]]),
        },
      ],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [PICKUP])).snapshots;
    expect(parcel).toMatchObject({ status: "at_pickup_point", pickup: true });
  });

  it("treats the empty envelope as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeOrlen({});
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [MISSING, "x/../y"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toEqual([MISSING]);
  });

  it("reports an unmapped code and keeps a refused code as unknown", async () => {
    const { fetchImpl } = fakeOrlen({
      [ACTIVE]: [{ status: 200, body: answer(ACTIVE, [["777", "18-11-2026, 08:00", "Nowy"]]) }],
      [PICKUP]: [{ status: 200, body: jsonp({ err: 1004 }) }],
    });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE, PICKUP]);
    expect(result.snapshots.map((p) => [p.barcode, p.status])).toEqual([
      [ACTIVE, null],
      [PICKUP, null],
    ]);
    expect(unknown).toEqual(["777", "1004"]);
  });

  it("stops fast on a network error, a 5xx or a broken wrapper", async () => {
    const network = fakeOrlen({ [ACTIVE]: [new Error("offline")] });
    await expect(
      plugin.track(context(network.fetchImpl).base, {}, null, [ACTIVE, PICKUP]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(network.calls).toEqual([ACTIVE]);

    const server = fakeOrlen({ [ACTIVE]: [{ status: 500, body: "" }] });
    await expect(
      plugin.track(context(server.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(TransientError);

    const html = fakeOrlen({ [ACTIVE]: [{ status: 200, body: "<html>blocked</html>" }] });
    await expect(
      plugin.track(context(html.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
