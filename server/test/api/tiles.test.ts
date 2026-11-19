import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/api/app.js";
import { createTestContext, signIn, type TestContext, type TestOptions } from "../helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const KEY = "very-secret-tile-key";
const CUSTOM = "https://tiles.example.org/{z}/{x}/{y}.jpg?key={key}";

let context: TestContext;
let upstream: string[];

beforeEach(() => {
  upstream = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    upstream.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(
      new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await context.close();
});

async function setUp(
  options: TestOptions = {},
): Promise<{ app: App; headers: Record<string, string> }> {
  context = await createTestContext(options);
  const app = await context.app();
  const session = await signIn(context, app);
  return { app, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } };
}

describe("map tiles", () => {
  it("serves listed layers with their content type, and the legacy path as OSM", async () => {
    const { app, headers } = await setUp();
    const satellite = await app.inject({ url: "/tiles/satellite/3/1/2", headers });
    expect(satellite.statusCode).toBe(200);
    expect(satellite.headers["content-type"]).toBe("image/jpeg");
    const legacy = await app.inject({ url: "/tiles/3/1/2.png", headers });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.headers["content-type"]).toBe("image/png");
    expect(upstream[1]).toBe("https://tile.openstreetmap.org/3/1/2.png");
  });

  it("answers 404 for a layer that is not listed, fetching nothing", async () => {
    const { app, headers } = await setUp();
    for (const url of ["/tiles/custom/1/0/0", "/tiles/evil/1/0/0", "/tiles/x%2F..%2Fy/1/0/0"]) {
      const response = await app.inject({ url, headers });
      expect([400, 404]).toContain(response.statusCode);
    }
    expect(upstream).toEqual([]);
  });

  it("needs a session", async () => {
    await setUp();
    const app = await context.app();
    expect((await app.inject({ url: "/tiles/osm/1/0/0" })).statusCode).toBe(401);
  });

  it("lists layers and defaults without upstream addresses or keys", async () => {
    const { app, headers } = await setUp({
      env: {
        OPENPARCELS_MAP_CUSTOM_URL: CUSTOM,
        OPENPARCELS_MAP_CUSTOM_KEY: KEY,
        OPENPARCELS_MAP_BASE_LAYER: "custom",
        OPENPARCELS_MAP_OVERLAY: "labels",
      },
    });
    const response = await app.inject({ url: "/api/v1/map/layers", headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(KEY);
    expect(response.body).not.toContain("example.org");
    expect(response.body).not.toContain("openstreetmap.org/{z}");
    const body = response.json<{ layers: { id: string }[]; default_base: string }>();
    expect(body.layers.map((layer) => layer.id)).toContain("custom");
    expect(body).toMatchObject({ default_base: "custom", default_overlay: "labels" });

    const config = await app.inject({ url: "/api/v1/settings/config", headers });
    expect(config.body).not.toContain(KEY);

    const tile = await app.inject({ url: "/tiles/custom/2/1/1", headers });
    expect(tile.statusCode).toBe(200);
    expect(upstream).toEqual([`https://tiles.example.org/2/1/1.jpg?key=${KEY}`]);
  });

  it("serves the CARTO styles once a CARTO key is set, with the key added on the server", async () => {
    const { app, headers } = await setUp({ env: { OPENPARCELS_MAP_CARTO_KEY: KEY } });
    const tile = await app.inject({ url: "/tiles/carto_dark/2/1/1", headers });
    expect(tile.statusCode).toBe(200);
    expect(upstream).toEqual([
      `https://basemaps.cartocdn.com/rastertiles/dark_all/2/1/1.png?key=${KEY}`,
    ]);
    const layers = await app.inject({ url: "/api/v1/map/layers", headers });
    expect(layers.body).not.toContain(KEY);
  });

  it("refuses an invalid custom template and applies a valid one at once", async () => {
    const { app, headers } = await setUp();
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: { OPENPARCELS_MAP_CUSTOM_URL: "http://tiles.example.org/{z}/{x}/{y}.png" },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: { OPENPARCELS_MAP_CUSTOM_URL: "https://tiles.example.org/{z}/{x}/{y}.png" },
    });
    expect(good.statusCode).toBe(200);
    const layers = await app.inject({ url: "/api/v1/map/layers", headers });
    // Without a custom default the plain map stays the default.
    expect(layers.json()).toMatchObject({ default_base: "osm", default_overlay: null });
    expect((await app.inject({ url: "/tiles/custom/1/0/0", headers })).statusCode).toBe(200);
  });
});
