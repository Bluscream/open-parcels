import { describe, expect, it } from "vitest";
import { dao } from "../../src/carriers/dao/index.js";
import { register } from "../../src/engine/registry.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { FakeClock } from "../helpers.js";
import { fakeContext, fakeNetwork, json, routeTable } from "./harness.js";

// Made-up tracking ids, tokens and names only.
const ACTIVE = "00000000000000000001";
const PICKUP_ID = "PP-TEST-1";
const SECRET = { refreshToken: "rt-0" };
const TOKEN = "POST auth.dao.as/realms/consumers/protocol/openid-connect/token";
const LIST = "GET apiv2.dao.as/consumer/shipment/tracking/v1/tracking";
const DETAIL = `${LIST}/${ACTIVE}`;
const POINT = `GET apiv2.dao.as/consumer/shipment/pickup-point/v1/pickup-points/${PICKUP_ID}`;
const plugin = register(dao);

const tokens = (n: number): Response =>
  json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 300 }, 200);

const status = (statusType: string, statusCode: number, statusText: string) => ({
  statusType,
  statusCode,
  statusText,
});

function parcel(id: string, last: ReturnType<typeof status>, extra: Record<string, unknown> = {}) {
  return {
    trackingId: id,
    sender: { name: "Example Shop" },
    receiver: { name: "Test Person" },
    lastEvent: { timestamp: "2026-11-18T09:00:00Z", status: last },
    delivery: { pickupPointId: PICKUP_ID },
    ...extra,
  };
}

const events = {
  events: [
    { timestamp: 1_763_366_400_000, status: status("STATUS_PROCESSING", 1, "Oprettet") },
    { timestamp: "2026-11-18T09:00:00Z", status: status("STATUS_IN_TRANSIT", 12, "På vej") },
  ],
};

describe("DAO account", () => {
  it("renews the session, lists both directions and adds history and the pickup point", async () => {
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [tokens(1)],
          [LIST]: [
            json({ items: [parcel(ACTIVE, status("STATUS_IN_TRANSIT", 12, "På vej"))] }, 200),
            json({ items: [] }, 200),
          ],
          [DETAIL]: [json(events, 200)],
          [POINT]: [json({ name: "Example Shop Point" }, 200)],
        },
        "host",
      ),
    ]);
    const { base, saved, unknown } = fakeContext(dao.http, fetchImpl);
    const result = await plugin.fetchAccount(base, {}, SECRET);
    expect(result.complete).toBe(true);
    expect(
      calls.filter((call) => call.key === LIST).map((c) => c.url.searchParams.get("bound")),
    ).toEqual(["IN", "OUT"]);
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer at-1");
    expect(saved).toEqual([expect.objectContaining({ refreshToken: "rt-1", accessToken: "at-1" })]);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "dao",
      barcode: ACTIVE,
      direction: "incoming",
      status: "in_transit",
      rawStatus: "På vej",
      plannedFrom: null,
      pickupPoint: "Example Shop Point",
      sender: "Example Shop",
    });
    expect(result.snapshots[0]?.history.map((event) => [event.at, event.status])).toEqual([
      ["2026-11-18T09:00:00.000Z", "in_transit"],
      ["2025-11-17T08:00:00.000Z", "registered"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("splits STATUS_OK by code and pickup point and marks outgoing parcels", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [tokens(1)],
          [LIST]: [
            json([parcel("A1", status("STATUS_OK", 51, "Udleveret"))], 200),
            json({ data: [parcel("B1", status("STATUS_OK", 32, "Klar"))] }, 200),
          ],
          [POINT]: [json({ data: { name: "Point" } }, 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(dao.http, fetchImpl);
    const { snapshots } = await plugin.fetchAccount(base, {}, SECRET);
    expect(snapshots.map((s) => [s.barcode, s.status, s.direction])).toEqual([
      ["A1", "delivered", "incoming"],
      ["B1", "at_pickup_point", "outgoing"],
    ]);
    expect(snapshots[0]?.deliveredAt).toBe("2026-11-18T09:00:00.000Z");
  });

  it("returns a complete empty list when the account has no parcels", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [tokens(1)],
          [LIST]: [json({ items: [] }, 200), json({ items: [] }, 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(dao.http, fetchImpl);
    expect(await plugin.fetchAccount(base, {}, SECRET)).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown status type and code", async () => {
    const odd = parcel(ACTIVE, status("STATUS_NEW", 77, "Noget nyt"), { delivery: {} });
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [tokens(1)],
          [LIST]: [json({ items: [odd] }, 200), json({ items: [] }, 200)],
          [DETAIL]: [json({ events: [] }, 200)],
        },
        "host",
      ),
    ]);
    const { base, unknown } = fakeContext(dao.http, fetchImpl);
    const [found] = (await plugin.fetchAccount(base, {}, SECRET)).snapshots;
    expect(found?.status).toBeNull();
    expect(unknown).toEqual(["status_type:STATUS_NEW", "status_code:77"]);
  });

  it("asks for a new sign-in only when DAO refuses the token, never on a network error", async () => {
    const refused = fakeNetwork([
      routeTable({ [TOKEN]: [json({ error: "invalid_grant" }, 400)] }, "host"),
    ]);
    await expect(
      plugin.fetchAccount(fakeContext(dao.http, refused.fetchImpl).base, {}, SECRET),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    const offline = fakeNetwork([routeTable({ [TOKEN]: [new Error("socket hang up")] }, "host")]);
    const error: unknown = await plugin
      .fetchAccount(fakeContext(dao.http, offline.fetchImpl).base, {}, SECRET)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect(offline.calls).toHaveLength(1);
  });

  it("renews a refused bearer once and gives up when the renewed one is refused too", async () => {
    const stored = {
      base: "",
      refreshToken: "rt-0",
      accessToken: "at-0",
      expiresAt: Date.parse("2027-01-01"),
    };
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [TOKEN]: [tokens(1), tokens(2)],
          [LIST]: [json({}, 401), json({}, 401)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(dao.http, fetchImpl, { session: stored });
    await expect(plugin.fetchAccount(base, {}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(calls.filter((call) => call.key === TOKEN).length).toBeLessThanOrEqual(2);
  });

  it("signs in with PKCE and refuses an address from another sign-in", async () => {
    const clock = new FakeClock();
    const { url, state } = await plugin.startSignIn({}, clock);
    const address = new URL(url);
    expect(address.searchParams.get("code_challenge_method")).toBe("S256");
    expect(address.searchParams.get("client_id")).toBe("dao-app");
    const { fetchImpl, calls } = fakeNetwork([routeTable({ [TOKEN]: [tokens(5)] }, "host")]);
    const { base } = fakeContext(dao.http, fetchImpl);
    const expected = address.searchParams.get("state") ?? "";
    await expect(
      plugin.finishSignIn(base.http, clock, state, "daoapp://auth-callback?code=c&state=wrong"),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    const secret = await plugin.finishSignIn(
      base.http,
      clock,
      state,
      `daoapp://auth-callback?code=c&state=${expected}`,
    );
    expect(secret).toEqual({ refreshToken: "rt-5" });
    expect(new URLSearchParams(calls[0]?.body ?? "").get("code_verifier")).not.toBeNull();
  });
});
