import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { waitText } from "../../src/api/routes/sources.js";
import { ConfigError, loadConfig } from "../../src/config.js";
import { KeyedMutex } from "../../src/engine/locks.js";
import { readCapped, type MinimalResponse } from "../../src/images/proxy.js";
import { hostAllowed, isNonPublicHostLiteral, isPrivateAddress } from "../../src/net/address.js";
import { networkCause, sameSite } from "../../src/plugin/http.js";
import { TileProxy } from "../../src/tiles/proxy.js";

/* Regressions for the security audit. Hosts and addresses are documentation or made-up values. */

describe("non-public addresses", () => {
  it("blocks every IPv6 form that carries an IPv4 address, and the special IPv4 ranges", () => {
    // What `new URL("https://[::ffff:127.0.0.1]/")` turns the host into.
    expect(new URL("https://[::ffff:127.0.0.1]/").hostname).toBe("[::ffff:7f00:1]");
    for (const address of [
      "[::ffff:7f00:1]",
      "::ffff:10.0.0.1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::a00:1",
      "2002:7f00:1::",
      "2001:0:4136:e378::1",
      "198.18.0.1",
      "198.19.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "240.0.0.1",
      "100.64.0.1",
      "fec0::1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "198.20.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses inward host literals for plug-in requests and matches the image allow-list", () => {
    expect(isNonPublicHostLiteral(new URL("https://[::ffff:127.0.0.1]/").hostname)).toBe(true);
    expect(isNonPublicHostLiteral(new URL("https://0x7f.1/").hostname)).toBe(true);
    expect(isNonPublicHostLiteral("api.localhost")).toBe(true);
    expect(isNonPublicHostLiteral("tracking.example.com")).toBe(false);
    expect(hostAllowed("img.media.example.com", [".media.example.com"])).toBe(true);
    expect(hostAllowed("media.example.com", [".media.example.com"])).toBe(true);
    expect(hostAllowed("evilmedia.example.com", [".media.example.com"])).toBe(false);
    expect(hostAllowed("other.example.com", ["img.example.com"])).toBe(false);
  });
});

function fakeResponse(
  chunks: Uint8Array[],
  length?: number,
): MinimalResponse & { cancelled: boolean } {
  let index = 0;
  const result = {
    cancelled: false,
    status: 200,
    ok: true,
    headers: {
      get: (name: string) =>
        name === "content-length" && length !== undefined ? String(length) : null,
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[index];
        index += 1;
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(next);
        }
      },
      cancel() {
        result.cancelled = true;
      },
    }),
    arrayBuffer: () => Promise.reject(new Error("must stream")),
  };
  return result;
}

describe("image size cap", () => {
  it("refuses a declared length over the cap without reading, and cuts a stream at the cap", async () => {
    await expect(readCapped(fakeResponse([], 11), 10)).rejects.toThrow("too large");
    const endless = fakeResponse([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    await expect(readCapped(endless, 10)).rejects.toThrow("too large");
    expect(endless.cancelled).toBe(true);
    expect(
      (await readCapped(fakeResponse([new Uint8Array(4), new Uint8Array(4)]), 10)).length,
    ).toBe(8);
  });
});

describe("same-site redirects", () => {
  it("use the public suffix list", () => {
    const allow = sameSite(new URL("https://www.shop.co.uk/"));
    expect(allow(new URL("https://login.shop.co.uk/"))).toBe(true);
    expect(allow(new URL("https://other.co.uk/"))).toBe(false);
    expect(sameSite(new URL("https://a.example.de/"))(new URL("https://b.example.de/"))).toBe(true);
  });

  it("name the network cause without values", () => {
    const timeout = Object.assign(new Error("x"), { name: "TimeoutError" });
    expect(networkCause(timeout)).toBe("timeout");
    expect(networkCause(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe(
      "ECONNRESET",
    );
  });
});

describe("per-source lock", () => {
  it("runs one holder per key at a time, in order, and other keys in parallel", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = mutex.exclusive("a", async () => {
      log.push("a1 start");
      await gate;
      log.push("a1 end");
    });
    const second = mutex.exclusive("a", () => {
      log.push("a2");
      return Promise.resolve();
    });
    const other = mutex.exclusive("b", () => {
      log.push("b");
      return Promise.resolve();
    });
    await other;
    expect(log).toEqual(["a1 start", "b"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["a1 start", "b", "a1 end", "a2"]);
    expect(mutex.busy("a")).toBe(false);
  });

  it("releases after a failure", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.exclusive("a", () => Promise.reject(new Error("boom")))).rejects.toThrow();
    expect(await mutex.exclusive("a", () => Promise.resolve(1))).toBe(1);
  });
});

describe("tile cache pruning", () => {
  it("drops tiles past the age limit, then the oldest beyond the budget", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "op-tiles-"));
    try {
      const now = Date.parse("2026-11-19T00:00:00Z");
      const tile = (name: string, ageDays: number, bytes: number): string => {
        const file = path.join(dir, "5", "1", name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.alloc(bytes));
        const at = (now - ageDays * 86_400_000) / 1000;
        utimesSync(file, at, at);
        return file;
      };
      const ancient = tile("1.png", 40, 10);
      const old = tile("2.png", 5, 60);
      const fresh = tile("3.png", 1, 60);
      const proxy = new TileProxy({
        cacheDir: dir,
        userAgent: "test",
        now: () => now,
        maxCacheBytes: 100,
      });
      expect(await proxy.prune()).toBe(2);
      expect([existsSync(ancient), existsSync(old), existsSync(fresh)]).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("configuration", () => {
  it("reads trusted proxies and refuses anything else", () => {
    const base = { OPENPARCELS_DATA_DIR: tmpdir(), OPENPARCELS_TIMEZONE: "UTC" };
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(
      loadConfig({ ...base, OPENPARCELS_TRUST_PROXY: "10.0.0.2, 172.18.0.0/16" }).trustProxy,
    ).toEqual(["10.0.0.2", "172.18.0.0/16"]);
    expect(() => loadConfig({ ...base, OPENPARCELS_TRUST_PROXY: "everyone" })).toThrow(ConfigError);
  });

  it("words a wait for people", () => {
    expect(waitText(30)).toBe("30 seconds");
    expect(waitText(900)).toBe("15 minutes");
    expect(waitText(21_600)).toBe("6 hours");
  });
});
