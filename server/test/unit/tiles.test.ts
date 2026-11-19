import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TileError, TileProxy, validTile } from "../../src/tiles/proxy.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function png(): Response {
  return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
}

describe("tile proxy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "op-tiles-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts only real tile coordinates", () => {
    expect(validTile(0, 0, 0)).toBe(true);
    expect(validTile(2, 3, 3)).toBe(true);
    expect(validTile(2, 4, 0)).toBe(false);
    expect(validTile(20, 0, 0)).toBe(false);
    expect(validTile(-1, 0, 0)).toBe(false);
  });

  it("identifies itself upstream, caches, and serves the cache next time", async () => {
    const calls: { url: string; agent: string | null }[] = [];
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: "open-parcels/test",
      fetchImpl: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        calls.push({ url, agent: new Headers(init?.headers).get("user-agent") });
        return Promise.resolve(png());
      },
    });
    const first = await proxy.get(3, 4, 5);
    expect(first).toEqual({ body: PNG, cached: false });
    expect(calls).toEqual([
      { url: "https://tile.openstreetmap.org/3/4/5.png", agent: "open-parcels/test" },
    ]);
    const second = await proxy.get(3, 4, 5);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("refuses bad coordinates without any request", async () => {
    let called = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: "t",
      fetchImpl: () => {
        called = true;
        return Promise.resolve(png());
      },
    });
    await expect(proxy.get(1, 5, 0)).rejects.toBeInstanceOf(TileError);
    expect(called).toBe(false);
  });

  it("serves a stale tile when the tile server refuses, and fails without one", async () => {
    let refuse = false;
    const proxy = new TileProxy({
      cacheDir: dir,
      userAgent: "t",
      fetchImpl: () => Promise.resolve(refuse ? new Response("blocked", { status: 403 }) : png()),
    });
    await proxy.get(1, 1, 1);
    const file = path.join(dir, "1", "1", "1.png");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(file, old, old);
    refuse = true;
    await expect(proxy.get(1, 1, 1)).resolves.toEqual({ body: PNG, cached: true });
    await expect(proxy.get(1, 0, 0)).rejects.toMatchObject({ statusCode: 502 });
  });
});
