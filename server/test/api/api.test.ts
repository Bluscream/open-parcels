import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HA_INGRESS_ADDRESS } from "../../src/api/auth-plugin.js";
import type { App } from "../../src/api/app.js";
import {
  createTestContext,
  OWNER_PASSWORD,
  SHORT_PASSWORD,
  signIn,
  WRONG_PASSWORD,
  type TestContext,
} from "../helpers.js";

let context: TestContext;
let app: App;

beforeEach(async () => {
  context = await createTestContext();
  app = await context.app();
});
afterEach(async () => {
  await context.close();
});

async function adminToken(
  session: { cookie: string; csrf: string },
  scopes: string[],
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    payload: { name: "test", scopes },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ token: string }>().token;
}

async function outboxTypes(): Promise<string[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("type")
    .orderBy("seq")
    .execute();
  return rows.map((row) => row.type);
}

describe("health and documentation", () => {
  it("answers health checks without authentication", async () => {
    expect((await app.inject("/api/v1/health/live")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/api/v1/health/ready")).json()).toEqual({ status: "ok" });
  });

  it("publishes an OpenAPI document listing the parcel routes", async () => {
    const doc = (await app.inject("/api/v1/openapi.json")).json<{
      openapi: string;
      paths: Record<string, unknown>;
    }>();
    expect(doc.openapi.startsWith("3.")).toBe(true);
    expect(Object.keys(doc.paths)).toContain("/api/v1/parcels/{id}");
  });
});

describe("first-start setup", () => {
  it("is required, needs the logged setup code, and works only once", async () => {
    const state = (await app.inject("/api/v1/session")).json<{
      setup_required: boolean;
      authenticated: boolean;
    }>();
    expect(state).toMatchObject({ setup_required: true, authenticated: false });

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_code: "AAAA-AAAA-AAAA", password: OWNER_PASSWORD },
    });
    expect(wrong.statusCode).toBe(403);

    await signIn(context, app);
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_code: "x", password: OWNER_PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });

  it("accepts a lower-case setup code without dashes", async () => {
    const code = (context.services.setup.code ?? "").replaceAll("-", "").toLowerCase();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_code: code, password: OWNER_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rejects short passwords", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: { setup_code: context.services.setup.code ?? "", password: SHORT_PASSWORD },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("sessions", () => {
  it("signs in with the owner password and throttles guessing", async () => {
    await signIn(context, app);
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { password: OWNER_PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { password: WRONG_PASSWORD },
      });
      expect(bad.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/session",
      payload: { password: OWNER_PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("requires the CSRF token for state-changing requests made with a cookie", async () => {
    const session = await signIn(context, app);
    const payload = { carrier: "dhl", barcode: "00340434000000000001" };
    const withoutCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: { cookie: session.cookie },
      payload,
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
      payload,
    });
    expect(withCsrf.statusCode).toBe(201);
  });

  it("expires sessions after 30 days without use", async () => {
    const session = await signIn(context, app);
    context.clock.advance(31 * 24 * 60 * 60 * 1000);
    const response = await app.inject({
      url: "/api/v1/parcels",
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(401);
  });

  it("signs out", async () => {
    const session = await signIn(context, app);
    await app.inject({
      method: "DELETE",
      url: "/api/v1/session",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    });
    const after = await app.inject({ url: "/api/v1/parcels", headers: { cookie: session.cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe("API tokens", () => {
  it("authenticate bearer requests and enforce scopes", async () => {
    const session = await signIn(context, app);
    const readOnly = await adminToken(session, ["read"]);
    const listed = await app.inject({
      url: "/api/v1/parcels",
      headers: { authorization: `Bearer ${readOnly}` },
    });
    expect(listed.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers: { authorization: `Bearer ${readOnly}` },
      payload: { carrier: "dhl", barcode: "00340434000000000001" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("never return the token value again and can be revoked", async () => {
    const session = await signIn(context, app);
    const token = await adminToken(session, ["read", "write"]);
    const list = (
      await app.inject({ url: "/api/v1/tokens", headers: { cookie: session.cookie } })
    ).json<{ id: string }[]>();
    expect(JSON.stringify(list)).not.toContain(token);
    const first = list[0];
    expect(first).toBeDefined();
    await app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${first?.id ?? ""}`,
      headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    });
    const after = await app.inject({
      url: "/api/v1/parcels",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("reject unknown tokens", async () => {
    const response = await app.inject({
      url: "/api/v1/parcels",
      headers: { authorization: "Bearer opk_nope" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("Home Assistant ingress", () => {
  it("trusts only the Supervisor address on the ingress listener", async () => {
    const ingress = await context.app({ trustedIngressAddress: HA_INGRESS_ADDRESS });
    const trusted = await ingress.inject({
      url: "/api/v1/parcels",
      remoteAddress: HA_INGRESS_ADDRESS,
    });
    expect(trusted.statusCode).toBe(200);
    const other = await ingress.inject({ url: "/api/v1/parcels", remoteAddress: "192.168.1.20" });
    expect(other.statusCode).toBe(401);
  });

  it("ignores the ingress address on the normal listener", async () => {
    const response = await app.inject({
      url: "/api/v1/parcels",
      remoteAddress: HA_INGRESS_ADDRESS,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("parcels", () => {
  it("detects the carrier when none is given, and says so when it cannot", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    // A made-up code in UPS's documented sample format.
    const detected = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { barcode: "1Z999AA10123456784" },
    });
    expect(detected.statusCode).toBe(201);
    expect(detected.json<{ carrier: string }>().carrier).toBe("ups");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { barcode: "NOFORMAT0001" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toBe("carrier_not_detected");
  });

  it("creates, reads, overrides and deletes, writing the canonical events", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { carrier: "dhl", barcode: "00340434000000000001", label: "Socks" },
    });
    expect(created.statusCode).toBe(201);
    const parcel = created.json<{
      id: string;
      status: string;
      history: unknown[];
      items: unknown[];
      live: unknown;
    }>();
    expect(parcel).toMatchObject({ status: "registered", history: [], items: [], live: null });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { carrier: "dhl", barcode: "00340434000000000001" },
    });
    expect(duplicate.statusCode).toBe(409);

    const inTransit = await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${parcel.id}`,
      headers,
      payload: { manual_status: "in_transit" },
    });
    expect(inTransit.json()).toMatchObject({ manual_status: "in_transit" });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${parcel.id}`,
      headers,
      payload: { manual_status: "delivered" },
    });
    // Same status again: no event.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${parcel.id}`,
      headers,
      payload: { manual_status: "delivered", label: "Renamed" },
    });
    expect(await outboxTypes()).toEqual([
      "parcel.registered",
      "parcel.status_changed",
      "parcel.delivered",
    ]);

    const listed = (await app.inject({ url: "/api/v1/parcels", headers })).json<unknown[]>();
    expect(listed).toHaveLength(1);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/parcels/${parcel.id}`, headers }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject({ url: `/api/v1/parcels/${parcel.id}`, headers })).statusCode).toBe(
      404,
    );
  });

  it("uses the outgoing event pair for outgoing parcels", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { carrier: "hermes", barcode: "H0000000000000000001", direction: "outgoing" },
    });
    const id = created.json<{ id: string }>().id;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${id}`,
      headers,
      payload: { manual_status: "delivered" },
    });
    expect(await outboxTypes()).toEqual([
      "parcel.outgoing_registered",
      "parcel.outgoing_delivered",
    ]);
  });

  it("validates input", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/parcels",
      headers,
      payload: { carrier: "", barcode: "1" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("invalid_request");
    const badId = await app.inject({ url: "/api/v1/parcels/not-a-uuid", headers });
    expect(badId.statusCode).toBe(400);
  });

  it("archives parcels out of the default list", async () => {
    const session = await signIn(context, app);
    const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
    const id = (
      await app.inject({
        method: "POST",
        url: "/api/v1/parcels",
        headers,
        payload: { carrier: "dpd", barcode: "00000000000001" },
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${id}`,
      headers,
      payload: { archived: true },
    });
    expect((await app.inject({ url: "/api/v1/parcels", headers })).json<unknown[]>()).toHaveLength(
      0,
    );
    expect(
      (await app.inject({ url: "/api/v1/parcels?include_archived=true", headers })).json<
        unknown[]
      >(),
    ).toHaveLength(1);
  });
});
