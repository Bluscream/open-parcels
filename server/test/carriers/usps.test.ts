import { describe, expect, it } from "vitest";
import { usps } from "../../src/carriers/usps/index.js";
import { register } from "../../src/engine/registry.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { fakeContext, fakeFetch } from "./fake-carrier.js";

// Made-up values only.
const CODE = "9400000000000000000001";
const TOKEN = "POST apis.usps.com/oauth2/v3/token";
const DETAIL = `GET apis.usps.com/tracking/v3/tracking/${CODE}`;
const keys = { consumerKey: "made-up-key", consumerSecret: ["made", "up", "value"].join("-") };
const plugin = register(usps);

const token = (n: number, scope = "tracking addresses") => ({
  status: 200,
  body: { access_token: `token-${n}`, expires_in: 28_800, scope },
});

function detail(statusCategory: string, status: string) {
  return {
    trackingNumber: CODE,
    statusCategory,
    status,
    trackingEvents: [
      { eventType: status, eventTimestamp: "2026-11-18T08:10:00-05:00", eventCode: "OF" },
      {
        eventType: "Arrived at USPS Regional Facility",
        eventTimestamp: "2026-11-17T22:00:00-05:00",
      },
      { eventType: "Shipping Label Created", eventTimestamp: "2026-11-16T09:00:00-05:00" },
    ],
  };
}

describe("USPS tracking", () => {
  it("signs in with the key pair, caches the token and maps status and history", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [TOKEN]: [token(1)],
      [DETAIL]: [
        { status: 200, body: detail("Out for Delivery", "Out for Delivery") },
        { status: 200, body: detail("Delivered", "Delivered, In/At Mailbox") },
      ],
    });
    const { base, saved, unknown } = fakeContext(usps.http, fetchImpl);
    const first = await plugin.track(base, {}, keys, [CODE]);
    expect(first.snapshots[0]).toMatchObject({
      carrier: "usps",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      // The Tracking API answer has no delivery window.
      plannedFrom: null,
      plannedTo: null,
      url: expect.stringContaining(CODE) as unknown,
    });
    expect(first.snapshots[0]?.history.map((event) => event.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    const second = await plugin.track(base, {}, keys, [CODE]);
    expect(second.snapshots[0]).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T13:10:00.000Z",
    });
    expect(calls.filter((call) => call.key === TOKEN)).toHaveLength(1);
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(saved).toHaveLength(1);
    expect(unknown).toEqual([]);
  });

  it("treats a 404 as not found", async () => {
    const { fetchImpl } = fakeFetch({ [TOKEN]: [token(1)], [DETAIL]: [{ status: 404, body: {} }] });
    const { base } = fakeContext(usps.http, fetchImpl);
    expect(await plugin.track(base, {}, keys, [CODE])).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown status category", async () => {
    const { fetchImpl } = fakeFetch({
      [TOKEN]: [token(1)],
      [DETAIL]: [{ status: 200, body: detail("Made-up Category", "Made-up Category") }],
    });
    const { base, unknown } = fakeContext(usps.http, fetchImpl);
    const result = await plugin.track(base, {}, keys, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: null, rawStatus: "Made-up Category" });
    expect(unknown).toEqual(["Made-up Category"]);
  });

  it("reports a refused key pair, or one without tracking, as a sign-in problem", async () => {
    const { fetchImpl } = fakeFetch({
      [TOKEN]: [{ status: 401, body: {} }, token(2, "addresses")],
    });
    const { base } = fakeContext(usps.http, fetchImpl);
    await expect(plugin.track(base, {}, keys, [CODE])).rejects.toBeInstanceOf(SignInRejectedError);
    await expect(plugin.track(base, {}, keys, [CODE])).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("renews a refused token once, then gives up", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [TOKEN]: [token(1), token(2)],
      [DETAIL]: [
        { status: 401, body: {} },
        { status: 401, body: {} },
      ],
    });
    const { base } = fakeContext(usps.http, fetchImpl);
    await expect(plugin.track(base, {}, keys, [CODE])).rejects.toBeInstanceOf(SignInRejectedError);
    expect(calls.map((call) => call.key)).toEqual([TOKEN, DETAIL, TOKEN, DETAIL]);
  });

  it("never asks for a new token on a network error", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [TOKEN]: [token(1)],
      [DETAIL]: [new Error("offline")],
    });
    const { base } = fakeContext(usps.http, fetchImpl);
    await expect(plugin.track(base, {}, keys, [CODE])).rejects.toBeInstanceOf(TransientError);
    expect(calls.map((call) => call.key)).toEqual([TOKEN, DETAIL]);
  });
});
