import { describe, expect, it } from "vitest";
import { ontrac } from "../../src/carriers/ontrac/index.js";
import { register, type BaseContext } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

// Made-up codes and values only.
const ACTIVE = "D10000000000001";
const DELIVERED = "D10000000000002";
const MISSING = "D10000000000003";

const plugin = register(ontrac);

type Reply = { status: number; body: unknown } | Error;

function fakeOnTrac(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    const code = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    calls.push(code);
    const reply = routes[code]?.shift() ?? { status: 404, body: { Title: "Not Found" } };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
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
    http: new PluginHttp(ontrac.http, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}

function pkg(code: string, events: [string, string][], extra: Record<string, unknown> = {}) {
  return {
    Packages: [
      {
        Tracking: code,
        Weight: 2,
        WeightUnits: "lbs",
        Consignee: { Name: "Test Person", City: "Sampletown" },
        Events: events.map(([EventCode, UtcEventDateTime]) => ({
          EventCode,
          UtcEventDateTime,
          Status: "In Transit",
        })),
        ...extra,
      },
    ],
  };
}

describe("OnTrac public tracking", () => {
  it("maps the newest event and reads the expected delivery and history", async () => {
    const { fetchImpl } = fakeOnTrac({
      [ACTIVE]: [
        {
          status: 200,
          body: pkg(
            ACTIVE,
            [
              ["EXRL", "2026-11-16T10:00:00"],
              ["OFDL", "2026-11-18T08:00:00"],
              ["ARRD", "2026-11-17T10:00:00Z"],
            ],
            { UtcExpectedDeliveryDateTime: "2026-11-18T22:00:00Z" },
          ),
        },
      ],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "ontrac",
      barcode: ACTIVE,
      status: "out_for_delivery",
      rawStatus: "OFDL",
      delivered: false,
      plannedTo: "2026-11-18T22:00:00.000Z",
      weightKg: 0.91,
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(parcel?.url).toContain(ACTIVE);
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
  });

  it("reports delivered with its time and no window", async () => {
    const { fetchImpl } = fakeOnTrac({
      [DELIVERED]: [
        {
          status: 200,
          body: pkg(DELIVERED, [["DLVD", "2026-11-18T09:00:00Z"]], {
            UtcDeliveryDateTime: "2026-11-18T09:00:00Z",
            UtcExpectedDeliveryDateTime: "2026-11-18T22:00:00Z",
          }),
        },
      ],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [DELIVERED])).snapshots;
    expect(parcel).toMatchObject({
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      plannedTo: null,
    });
  });

  it("treats the structured 404 and an empty package list as not found", async () => {
    const { fetchImpl, calls } = fakeOnTrac({
      [MISSING]: [{ status: 404, body: { Title: "Not Found", Status: 404 } }],
      [ACTIVE]: [{ status: 200, body: { Packages: [] } }],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [MISSING, ACTIVE, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toEqual([MISSING, ACTIVE]);
  });

  it("reports an unmapped code once and keeps the status null", async () => {
    const { fetchImpl } = fakeOnTrac({
      [ACTIVE]: [
        {
          status: 200,
          body: pkg(ACTIVE, [
            ["NFRP", "2026-11-18T08:00:00Z"],
            ["NFRP", "2026-11-18T07:00:00Z"],
          ]),
        },
      ],
    });
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [ACTIVE])).snapshots;
    expect(parcel).toMatchObject({ status: null, rawStatus: "NFRP", delivered: false });
    expect(unknown).toEqual(["NFRP"]);
  });

  it("stops fast on a network error, a 5xx or an unexpected 404 body", async () => {
    const network = fakeOnTrac({ [ACTIVE]: [new Error("offline")] });
    await expect(
      plugin.track(context(network.fetchImpl).base, {}, null, [ACTIVE, DELIVERED]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(network.calls).toEqual([ACTIVE]);

    const server = fakeOnTrac({ [ACTIVE]: [{ status: 502, body: {} }] });
    await expect(
      plugin.track(context(server.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(TransientError);

    const odd = fakeOnTrac({ [ACTIVE]: [{ status: 404, body: { message: "gone" } }] });
    await expect(
      plugin.track(context(odd.fetchImpl).base, {}, null, [ACTIVE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
