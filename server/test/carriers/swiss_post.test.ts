import { beforeEach, describe, expect, it } from "vitest";
import { resetWordingCache, swissPost } from "../../src/carriers/swiss_post/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(swissPost);

// Made-up codes, places and values only.
const CODE = "99.00.000000.00000001";
const BASE = "service.post.ch/ekp-web";
const USER = `GET ${BASE}/api/user`;
const REGISTER = `POST ${BASE}/api/history`;
const RESULT = `GET ${BASE}/api/history/not-included/h-1`;
const EVENTS = `GET ${BASE}/api/shipment/id/id-1/events`;
const TEXTS = `GET ${BASE}/core/rest/translations/en/shipment-text-messages`;

const handshake = (n = 1): Answer => json({ userIdentifier: `<[anonymous]>u-${n}` }, 200);
const registered = (): Answer => json({ hash: "h-1" }, 200);

function shipment(globalStatus: string, extra: object = {}) {
  return {
    shipmentNumber: CODE,
    identity: "id-1",
    globalStatus,
    status: "Text zum Status",
    sender: "Testfirma AG",
    addressee: { zip: "9999", city: "Teststadt" },
    physicalProperties: { weight: 1140, dimension1: 300, dimension2: 200, dimension3: 100 },
    ...extra,
  };
}

/** The handshake answer must carry the CSRF header, which the route harness cannot set. */
function withCsrf(routes: Record<string, Answer[]>) {
  const { fetchImpl, calls } = network(routes);
  const wrapped: typeof fetchImpl = async (url, init) => {
    const response = await fetchImpl(url, init);
    if (url.pathname.endsWith("/api/user") && response.status === 200) {
      const headers = new Headers(response.headers);
      headers.set("x-csrf-token", "csrf-1");
      headers.append("set-cookie", "NPKlpipSession=s-1; Path=/; Secure");
      return new Response(await response.text(), { status: 200, headers });
    }
    return response;
  };
  return { fetchImpl: wrapped, calls };
}

describe("Swiss Post tracking", () => {
  beforeEach(() => {
    resetWordingCache();
  });

  it("registers the code, reads the window, weight and worded history", async () => {
    const { fetchImpl, calls } = withCsrf({
      [USER]: [handshake()],
      [REGISTER]: [registered()],
      [RESULT]: [
        json(
          [
            shipment("IN_DELIVERY", {
              deliveryRange: { start: "2026-11-18T09:00:00Z", end: "2026-11-18T12:00:00Z" },
            }),
          ],
          200,
        ),
      ],
      [EVENTS]: [
        json(
          [
            { eventCode: "PARCEL.*.65.4000", timestamp: "2026-11-18T07:00:00Z" },
            { eventCode: "PARCEL.*.65.1003", timestamp: "2026-11-17T07:00:00Z" },
          ],
          200,
        ),
      ],
      [TEXTS]: [
        json({ "shipment-text--": { "PARCEL.*.ALL_PROD.4000.*": "Out for delivery" } }, 200),
      ],
    });
    const { base, saved } = fakeContext(swissPost.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "swiss_post",
      barcode: CODE,
      status: "out_for_delivery",
      plannedFrom: "2026-11-18T09:00:00.000Z",
      plannedTo: "2026-11-18T12:00:00.000Z",
      sender: "Testfirma AG",
      receiver: "9999 Teststadt",
      weightKg: 1.14,
    });
    expect(parcel?.history.map((e) => e.rawStatus)).toEqual([
      "Out for delivery",
      "PARCEL.*.65.1003",
    ]);
    const registration = calls.find((c) => c.key === REGISTER);
    expect(registration?.headers.get("x-csrf-token")).toBe("csrf-1");
    expect(registration?.headers.get("cookie")).toContain("NPKlpipSession=s-1");
    expect(registration?.url.searchParams.get("userId")).toBe("<[anonymous]>u-1");
    expect(saved.at(-1)).toMatchObject({ user: "<[anonymous]>u-1", csrf: "csrf-1" });
  });

  it("treats an empty shipment list as not found", async () => {
    const { fetchImpl } = withCsrf({
      [USER]: [handshake()],
      [REGISTER]: [registered()],
      [RESULT]: [json([], 200)],
    });
    const { base } = fakeContext(swissPost.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports an unknown global status and keeps the delivered flag", async () => {
    const { fetchImpl } = withCsrf({
      [USER]: [handshake()],
      [REGISTER]: [registered()],
      [RESULT]: [
        json(
          [shipment("SOMETHING_NEW", { delivered: true, deliveryDate: "2026-11-18T10:00:00Z" })],
          200,
        ),
      ],
    });
    const { base, unknownKeys: unknown } = fakeContext(swissPost.http, fetchImpl);
    const [parcel] = (await plugin.track(base, { eventHistory: false }, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ status: null, delivered: true, plannedFrom: null });
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("renews an expired session once, then gives up", async () => {
    const stored = { jar: null, user: "<[anonymous]>old", csrf: "old" };
    const { fetchImpl, calls } = withCsrf({
      [REGISTER]: [json({}, 403), json({}, 403)],
      [USER]: [handshake(2)],
    });
    const { base } = fakeContext(swissPost.http, fetchImpl, { session: stored });
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    expect(calls.filter((c) => c.key === USER)).toHaveLength(1);
  });

  it("never renews the session after a network error", async () => {
    const stored = { jar: null, user: "<[anonymous]>old", csrf: "old" };
    const { fetchImpl, calls } = withCsrf({ [REGISTER]: [new Error("reset")] });
    const { base } = fakeContext(swissPost.http, fetchImpl, { session: stored });
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    expect(calls.map((c) => c.key)).toEqual([REGISTER]);
  });

  it("keeps the parcel when the timeline fails", async () => {
    const { fetchImpl } = withCsrf({
      [USER]: [handshake()],
      [REGISTER]: [registered()],
      [RESULT]: [json([shipment("TO_BE_DELIVERED")], 200)],
      [EVENTS]: [json({}, 500)],
    });
    const { base } = fakeContext(swissPost.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ status: "in_transit", history: [] });
  });
});
