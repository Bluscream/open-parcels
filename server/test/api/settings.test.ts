import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { Geocoder } from "../../src/geo/geocoder.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/* Every place and coordinate here is made up. */

let context: TestContext;
afterEach(async () => {
  await context.close();
});

async function setUp(
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<{ app: App; headers: Record<string, string> }> {
  context = await createTestContext(fetchImpl === undefined ? {} : { fetchImpl });
  const app = await context.app();
  const session = await signIn(context, app);
  return { app, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } };
}

describe("home location", () => {
  it("is unset, then set, read back and forgotten", async () => {
    const { app, headers } = await setUp();
    expect((await app.inject({ url: "/api/v1/settings", headers })).json()).toEqual({ home: null });

    const home = { latitude: 52.123456, longitude: 13.654321, label: "Example Street 1" };
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/home",
      headers,
      payload: home,
    });
    expect(put.json()).toEqual(home);
    expect((await app.inject({ url: "/api/v1/settings", headers })).json()).toEqual({ home });

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/home",
      headers,
      payload: { latitude: 95, longitude: 0 },
    });
    expect(bad.statusCode).toBe(400);

    const removed = await app.inject({ method: "DELETE", url: "/api/v1/settings/home", headers });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ url: "/api/v1/settings", headers })).json()).toEqual({ home: null });
  });

  it("looks places up through the server and reports a failing search", async () => {
    const seen: URL[] = [];
    const { app, headers } = await setUp((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      seen.push(url);
      if (url.searchParams.get("q") === "broken") {
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      return Promise.resolve(
        Response.json([{ display_name: "Example Town, Nowhere", lat: "50.5", lon: "8.25" }]),
      );
    });
    const found = await app.inject({ url: "/api/v1/geocode?q=Example%20Town", headers });
    expect(found.json()).toEqual([
      { label: "Example Town, Nowhere", latitude: 50.5, longitude: 8.25 },
    ]);
    expect(seen[0]?.hostname).toBe("nominatim.openstreetmap.org");

    const failed = await app.inject({ url: "/api/v1/geocode?q=broken", headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "geocode_failed" });
  });
});

describe("Geocoder", () => {
  it("spaces requests a second apart and answers repeats from its cache", async () => {
    let clock = 100_000;
    const waits: number[] = [];
    let calls = 0;
    const geocoder = new Geocoder({
      userAgent: "test",
      now: () => clock,
      sleep: (ms) => {
        waits.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(Response.json([{ display_name: "X", lat: "1", lon: "2" }]));
      },
    });
    await geocoder.search("one");
    await geocoder.search("two");
    await geocoder.search("  ONE ");
    expect(calls).toBe(2);
    expect(waits).toEqual([1_000]);
  });
});
