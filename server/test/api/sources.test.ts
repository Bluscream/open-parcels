import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { FakeWorld, fakePost, fakeShop } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;

beforeEach(async () => {
  context = await createTestContext({ plugins: [fakePost(new FakeWorld())] });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
});
afterEach(async () => {
  await context.close();
});

const credentials = { username: "user@example.invalid", password: ["made", "up"].join("-") };

describe("carriers and sources API", () => {
  it("lists installed carriers with their form schema", async () => {
    const carriers = (await app.inject({ url: "/api/v1/carriers", headers })).json<
      { id: string; sign_in: string; config_schema: unknown }[]
    >();
    expect(carriers).toEqual([expect.objectContaining({ id: "fakepost", sign_in: "credentials" })]);
    expect(carriers[0]?.config_schema).toMatchObject({ type: "object" });
  });

  it("accepts body-less calls whatever Content-Type the client sends", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    for (const type of ["application/octet-stream", "application/json", undefined]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/sources/${missing}/sync`,
        headers: type === undefined ? headers : { ...headers, "content-type": type },
      });
      expect(response.statusCode).toBe(404);
    }
    const junk = await app.inject({
      method: "POST",
      url: `/api/v1/sources/${missing}/sync`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(junk.statusCode).toBe(415);
  });

  it("creates a source without ever returning its sign-in data", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: { plugin: "fakepost", kind: "account", label: "Mine", secret: credentials },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("example.invalid");
    expect(created.json()).toMatchObject({ has_secret: true, state: "ok" });
    const listed = await app.inject({ url: "/api/v1/sources", headers });
    expect(listed.body).not.toContain("made-up");
  });

  it("rejects unknown plug-ins and kinds the plug-in does not offer", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: { plugin: "nope", kind: "account", label: "x" },
    });
    expect(unknown.statusCode).toBe(400);
    const wrongKind = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: { plugin: "fakepost", kind: "shop", label: "x" },
    });
    expect(wrongKind.statusCode).toBe(400);
  });

  it("disables, re-enables, replaces the secret, syncs and deletes", async () => {
    const id = (
      await app.inject({
        method: "POST",
        url: "/api/v1/sources",
        headers,
        payload: { plugin: "fakepost", kind: "account", label: "Mine", secret: credentials },
      })
    ).json<{ id: string }>().id;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/sources/${id}`,
          headers,
          payload: { enabled: false },
        })
      ).json(),
    ).toMatchObject({ state: "disabled" });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/sources/${id}`,
          headers,
          payload: { enabled: true, label: "Renamed" },
        })
      ).json(),
    ).toMatchObject({ state: "ok", label: "Renamed" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/sources/${id}/secret`,
          headers,
          payload: { secret: credentials },
        })
      ).statusCode,
    ).toBe(204);
    // Sign-in data that does not fit the plug-in is refused before it is stored.
    const malformed = await app.inject({
      method: "PUT",
      url: `/api/v1/sources/${id}/secret`,
      headers,
      payload: { secret: { unexpected: 1 } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "invalid_source" });
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/sources/${id}/sync`, headers })).statusCode,
    ).toBe(202);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/sources/${id}`, headers })).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: "/api/v1/sources", headers })).json()).toEqual([]);
  });

  it("signs in with a pasted link and stores the result encrypted", async () => {
    const shopContext = await createTestContext({ plugins: [fakeShop(new FakeWorld())] });
    try {
      const shopApp = await shopContext.app();
      const session = await signIn(shopContext, shopApp);
      const h = { cookie: session.cookie, "x-csrf-token": session.csrf };
      const id = (
        await shopApp.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: h,
          payload: { plugin: "fakeshop", kind: "shop", label: "Shop" },
        })
      ).json<{ id: string }>().id;

      const early = await shopApp.inject({
        method: "POST",
        url: `/api/v1/sources/${id}/sign-in/finish`,
        headers: h,
        payload: { pasted: "https://x.invalid/?code=1" },
      });
      expect(early.statusCode).toBe(400);

      const start = await shopApp.inject({
        method: "POST",
        url: `/api/v1/sources/${id}/sign-in/start`,
        headers: h,
      });
      expect(start.json()).toEqual({ url: "https://shop.example.invalid/sign-in?state=s1" });
      const bad = await shopApp.inject({
        method: "POST",
        url: `/api/v1/sources/${id}/sign-in/finish`,
        headers: h,
        payload: { pasted: "https://shop.example.invalid/done" },
      });
      expect(bad.json()).toMatchObject({ error: "sign_in_failed" });
      const good = await shopApp.inject({
        method: "POST",
        url: `/api/v1/sources/${id}/sign-in/finish`,
        headers: h,
        payload: { pasted: "https://shop.example.invalid/done?code=abc" },
      });
      expect(good.statusCode).toBe(204);
      expect((await shopContext.services.sources.get(id))?.hasSecret).toBe(true);
      const row = await shopContext.services.db
        .selectFrom("sources")
        .select("secret_blob")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row.secret_blob?.toString("utf8") ?? "").not.toContain("rt-abc");
    } finally {
      await shopContext.close();
    }
  });

  it("needs the admin scope to change sources", async () => {
    const token = (
      await app.inject({
        method: "POST",
        url: "/api/v1/tokens",
        headers,
        payload: { name: "ro", scopes: ["read", "write"] },
      })
    ).json<{ token: string }>().token;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: { authorization: `Bearer ${token}` },
      payload: { plugin: "fakepost", kind: "account", label: "x" },
    });
    expect(response.statusCode).toBe(403);
  });
});
