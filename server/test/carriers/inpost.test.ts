import { describe, expect, it } from "vitest";
import { inpost } from "../../src/carriers/inpost/index.js";
import { register } from "../../src/engine/registry.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import type { FetchLike } from "../../src/plugin/http.js";
import { fakeContext, fakeNetwork, json } from "./harness.js";
import { pasted } from "./pasted.js";

// Made-up codes and values only.
const ACTIVE = "990000000000000000000001";
const MISSING = "990000000000000000000009";
const SECRET = { refreshToken: ["rt", "made", "up"].join("-"), market: "PL" as const };

const plugin = register(inpost);

type Reply = { status: number; body: unknown } | Error;

/** Routes requests by "METHOD host/path" to scripted replies, used in order. */
function fake(routes: Record<string, Reply[]>) {
  const calls: { key: string; auth: string | null; body: string | null }[] = [];
  const { fetchImpl } = fakeNetwork([
    (call) => {
      calls.push({
        key: call.key,
        auth: call.headers.get("authorization"),
        body: call.init.body instanceof URLSearchParams ? call.init.body.toString() : null,
      });
      const reply = routes[call.key]?.shift() ?? { status: 404, body: {} };
      return reply instanceof Error ? reply : json(reply.body, reply.status);
    },
  ]);
  return { fetchImpl, calls };
}

function context(fetchImpl: FetchLike, session: unknown = null) {
  const { base, saved, unknownKeys } = fakeContext(inpost.http, fetchImpl, { session });
  return { base, saved, unknown: unknownKeys };
}

const TRACK = (code: string) => `GET inposteasy.com/api/tracking/${code}`;
const TOKEN = "POST account.inpost-group.com/oauth2/token";
const PL_INBOX = "GET api-inmobile-pl.easypack24.net/v3/parcels/tracked";
const IT_INBOX = "GET api-inmobile-pl.easypack24.net/global/cps/api/v1/parcels";

function trackingBody(status: string) {
  return {
    trackingNumber: ACTIVE,
    status,
    statusTitle: "Latest step",
    trackingDetails: [
      { status: "CRE.1001", statusTitle: "Created", datetime: "2026-11-16T10:00:00Z" },
      { status: "MMD.1002", statusTitle: "In the hub", datetime: "2026-11-17T10:00:00Z" },
      { status, statusTitle: "Latest step", datetime: "2026-11-18T08:00:00Z" },
    ],
  };
}

describe("inpost tracking", () => {
  it("reads a found parcel with status and history; the public tracking has no window", async () => {
    const { fetchImpl } = fake({
      [TRACK(ACTIVE)]: [{ status: 200, body: trackingBody("EOL.1001") }],
    });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, { country: "IT" }, null, [ACTIVE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "inpost",
      barcode: ACTIVE,
      status: "delivered",
      rawStatus: "Latest step",
      delivered: true,
      deliveredAt: "2026-11-18T08:00:00.000Z",
      plannedFrom: null,
      plannedTo: null,
      url: `https://inpost.it/trova-il-tuo-pacco?number=${ACTIVE}`,
    });
    expect(parcel?.history.map((event) => event.status)).toEqual([
      "delivered",
      "in_transit",
      "registered",
    ]);
    expect(unknown).toEqual([]);
  });

  it("treats a 404 or a body reporting 404 as not found", async () => {
    const { fetchImpl } = fake({
      [TRACK(MISSING)]: [{ status: 404, body: {} }],
      [TRACK(ACTIVE)]: [{ status: 200, body: { status: 404, error: "Not Found" } }],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [MISSING, ACTIVE]);
    expect(result).toEqual({ snapshots: [], complete: true });
  });

  it("treats a body reporting 500 as an outage, not a parcel", async () => {
    const { fetchImpl } = fake({ [TRACK(ACTIVE)]: [{ status: 200, body: { status: 500 } }] });
    const { base } = context(fetchImpl);
    await expect(plugin.track(base, {}, null, [ACTIVE])).rejects.toBeInstanceOf(TransientError);
  });

  it("reports an unknown status code and keeps the status null", async () => {
    const { fetchImpl } = fake({
      [TRACK(ACTIVE)]: [{ status: 200, body: trackingBody("XYZ.4242") }],
    });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE]);
    expect(result.snapshots[0]?.status).toBeNull();
    expect(unknown).toContain("XYZ.4242");
  });
});

function plParcel(status: string, statusGroup: string) {
  return {
    shipmentNumber: ACTIVE,
    status,
    statusGroup,
    sender: { name: "Example Shop" },
    receiver: "Test Person",
    pickUpPoint: { name: "TST01M" },
    openCode: "000000",
    qrCode: "made-up-qr",
    operations: { collect: true },
    eventLog: [
      { name: "CONFIRMED", date: "2026-11-16T10:00:00Z" },
      { name: "COD_COMPLETED", date: "2026-11-17T09:00:00Z" },
      { name: "READY_TO_PICKUP", date: "2026-11-18T08:00:00Z" },
    ],
  };
}

describe("inpost account", () => {
  it("lists the Polish inbox, renews the token once when refused, and saves the session", async () => {
    const { fetchImpl, calls } = fake({
      [TOKEN]: [
        { status: 200, body: { access_token: "at-1", refresh_token: "rt-2" } },
        { status: 200, body: { access_token: "at-2" } },
      ],
      [PL_INBOX]: [
        { status: 401, body: {} },
        { status: 200, body: { parcels: [plParcel("ready_to_pickup", "TO_PICKUP")] } },
      ],
    });
    const { base, saved, unknown } = context(fetchImpl);
    const result = await plugin.fetchAccount(base, {}, SECRET);
    expect(result.complete).toBe(true);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "TST01M",
      sender: "Example Shop",
      receiver: "Test Person",
      plannedFrom: null,
    });
    expect(parcel?.history.map((event) => event.status)).toEqual([
      "at_pickup_point",
      null,
      "registered",
    ]);
    expect(JSON.stringify(parcel?.raw)).not.toContain("openCode");
    expect(unknown).toEqual([]);
    expect(calls.filter((call) => call.key === PL_INBOX).map((call) => call.auth)).toEqual([
      "Bearer at-1",
      "Bearer at-2",
    ]);
    expect(saved.at(-1)).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
  });

  it("falls back to the status group and reports the unknown detailed status", async () => {
    const { fetchImpl } = fake({
      [TOKEN]: [{ status: 200, body: { access_token: "at-1" } }],
      [PL_INBOX]: [
        { status: 200, body: { parcels: [plParcel("brand_new_state", "IN_DELIVERY")] } },
      ],
    });
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.fetchAccount(base, {}, SECRET);
    expect(result.snapshots[0]?.status).toBe("in_transit");
    expect(unknown).toEqual(["brand_new_state"]);
  });

  it("reads the Italian inbox across pages", async () => {
    const event = (status: string, eventTime: string) => ({ status, eventCode: status, eventTime });
    const parcel = {
      primaryParcelNumber: ACTIVE,
      events: [
        event("at_the_origin", "2026-11-16T10:00:00Z"),
        event("delivered", "2026-11-18T08:00:00Z"),
      ],
    };
    const { fetchImpl, calls } = fake({
      [TOKEN]: [{ status: 200, body: { access_token: "at-1" } }],
      [IT_INBOX]: [
        { status: 200, body: { parcels: [], nextPage: { pagingState: "page-2" } } },
        { status: 200, body: { parcels: [parcel] } },
      ],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.fetchAccount(base, {}, { ...SECRET, market: "IT" });
    expect(calls.filter((call) => call.key === IT_INBOX)).toHaveLength(2);
    expect(result.snapshots[0]).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T08:00:00.000Z",
    });
  });

  it("asks for a new sign-in when the refresh token is refused", async () => {
    const { fetchImpl } = fake({ [TOKEN]: [{ status: 400, body: { error: "invalid_grant" } }] });
    const { base } = context(fetchImpl);
    await expect(plugin.fetchAccount(base, {}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("treats a network error as transient and never signs in again", async () => {
    const { fetchImpl, calls } = fake({ [TOKEN]: [new Error("offline")] });
    const { base } = context(fetchImpl);
    const error: unknown = await plugin.fetchAccount(base, {}, SECRET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(SignInRejectedError);
    expect(calls).toHaveLength(1);
  });

  it("does not renew the token on an inbox outage", async () => {
    const { fetchImpl, calls } = fake({
      [TOKEN]: [{ status: 200, body: { access_token: "at-1" } }],
      [PL_INBOX]: [{ status: 502, body: {} }],
    });
    const { base } = context(fetchImpl);
    await expect(plugin.fetchAccount(base, {}, SECRET)).rejects.toBeInstanceOf(TransientError);
    expect(calls.map((call) => call.key)).toEqual([TOKEN, PL_INBOX]);
  });
});

describe("inpost sign-in", () => {
  it("builds a PKCE sign-in and exchanges the pasted callback for a refresh token", async () => {
    const { fetchImpl, calls } = fake({
      [TOKEN]: [{ status: 200, body: { access_token: "a.e30.b", refresh_token: "rt-1" } }],
    });
    const { base } = context(fetchImpl);
    const started = await pasted(plugin).start({ market: "PL", language: "pl" }, base.clock);
    const url = new URL(started.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("lang")).toBe("pl-PL");
    const state = url.searchParams.get("state") ?? "";
    const secret = await pasted(plugin).finish(
      base.http,
      base.clock,
      started.state,
      `https://account.inpost-group.com/callback?code=c-1&state=${state}`,
    );
    expect(secret).toEqual({ refreshToken: "rt-1", market: "PL" });
    expect(calls[0]?.body).toContain("grant_type=authorization_code");
  });

  it("refuses a callback from another host or sign-in", async () => {
    const { fetchImpl, calls } = fake({});
    const { base } = context(fetchImpl);
    const started = await pasted(plugin).start({}, base.clock);
    await expect(
      pasted(plugin).finish(
        base.http,
        base.clock,
        started.state,
        "https://example.test/callback?code=c&state=s",
      ),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    expect(calls).toHaveLength(0);
  });
});
