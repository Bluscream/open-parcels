import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImageProxy,
  isPrivateAddress,
  type ImageFetch,
  type MinimalResponse,
} from "../../src/images/proxy.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function response(
  status: number,
  headers: Record<string, string>,
  body = Buffer.alloc(10, 1),
): MinimalResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: () =>
      Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  };
}

function proxy(
  fetchImpl: ImageFetch,
  addresses: Record<string, string[]> = {},
  maxCacheBytes?: number,
) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "open-parcels-img-"));
  dirs.push(cacheDir);
  const instance = new ImageProxy({
    secretKey: randomBytes(32),
    cacheDir,
    logger: pino({ level: "silent" }),
    fetchImpl,
    resolve: (host) => Promise.resolve(addresses[host] ?? ["93.184.216.34"]),
    ...(maxCacheBytes === undefined ? {} : { maxCacheBytes }),
  });
  return { instance, cacheDir };
}

function parts(pathValue: string | null): [string, string] {
  const file = (pathValue ?? "").replace("/img/", "");
  const [token = "", signature = ""] = file.split(".");
  return [token, signature];
}

describe("private address detection", () => {
  it("covers private, loopback, link-local and mapped addresses", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "192.168.2.11",
      "172.16.5.4",
      "169.254.1.1",
      "100.100.1.10",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:192.168.1.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "172.32.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("image proxy", () => {
  it("serves signed images and caches them, sharing one download", async () => {
    let calls = 0;
    const { instance } = proxy(() => {
      calls += 1;
      return Promise.resolve(response(200, { "content-type": "image/jpeg" }));
    });
    const [token, signature] = parts(instance.pathFor("https://images.example.invalid/item.jpg"));
    const [first, second] = await Promise.all([
      instance.get(token, signature),
      instance.get(token, signature),
    ]);
    expect(first.type).toBe("image/jpeg");
    expect(second.body.equals(first.body)).toBe(true);
    await instance.get(token, signature);
    expect(calls).toBe(1);
  });

  it("refuses forged or tampered addresses", async () => {
    const { instance } = proxy(() =>
      Promise.resolve(response(200, { "content-type": "image/png" })),
    );
    const [token, signature] = parts(instance.pathFor("https://images.example.invalid/a.png"));
    const [otherToken] = parts(instance.pathFor("https://images.example.invalid/b.png"));
    await expect(instance.get(otherToken, signature)).rejects.toMatchObject({ statusCode: 404 });
    await expect(instance.get(token, "x".repeat(32))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("only proxies https", () => {
    const { instance } = proxy(() => Promise.resolve(response(200, {})));
    expect(instance.pathFor("http://images.example.invalid/a.png")).toBeNull();
    expect(instance.pathFor("file:///etc/passwd")).toBeNull();
    expect(instance.pathFor("not a url")).toBeNull();
  });

  it("refuses hosts that resolve to private addresses, also after a redirect", async () => {
    const internal = proxy(() => Promise.resolve(response(200, { "content-type": "image/png" })), {
      "nas.example.invalid": ["192.168.2.11"],
    });
    const [token, signature] = parts(
      internal.instance.pathFor("https://nas.example.invalid/a.png"),
    );
    await expect(internal.instance.get(token, signature)).rejects.toMatchObject({
      statusCode: 502,
    });

    const redirecting = proxy(
      (url) =>
        Promise.resolve(
          url.hostname === "cdn.example.invalid"
            ? response(302, { location: "https://nas.example.invalid/x.png" })
            : response(200, { "content-type": "image/png" }),
        ),
      { "nas.example.invalid": ["10.0.0.5"] },
    );
    const [rToken, rSignature] = parts(
      redirecting.instance.pathFor("https://cdn.example.invalid/a.png"),
    );
    await expect(redirecting.instance.get(rToken, rSignature)).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("refuses non-images and oversized files", async () => {
    const html = proxy(() => Promise.resolve(response(200, { "content-type": "text/html" })));
    const [token, signature] = parts(html.instance.pathFor("https://images.example.invalid/a.png"));
    await expect(html.instance.get(token, signature)).rejects.toMatchObject({ statusCode: 502 });

    const huge = proxy(() =>
      Promise.resolve(
        response(200, { "content-type": "image/png" }, Buffer.alloc(6 * 1024 * 1024)),
      ),
    );
    const [hToken, hSignature] = parts(
      huge.instance.pathFor("https://images.example.invalid/b.png"),
    );
    await expect(huge.instance.get(hToken, hSignature)).rejects.toMatchObject({ statusCode: 502 });
  });

  it("prunes the oldest files beyond the budget", async () => {
    const { instance, cacheDir } = proxy(
      () => Promise.resolve(response(200, { "content-type": "image/png" }, Buffer.alloc(1000, 2))),
      {},
      1500,
    );
    for (const name of ["a", "b", "c"]) {
      const [token, signature] = parts(
        instance.pathFor(`https://images.example.invalid/${name}.png`),
      );
      await instance.get(token, signature);
    }
    expect(await instance.prune()).toBe(2);
    expect(readdirSync(cacheDir).filter((file) => file.endsWith(".bin"))).toHaveLength(1);
  });
});
