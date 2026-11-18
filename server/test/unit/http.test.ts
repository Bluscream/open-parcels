import { describe, expect, it } from "vitest";
import { RateLimitedError, TransientError } from "../../src/plugin/errors.js";
import {
  DEFAULT_USER_AGENT,
  HostLimiter,
  parseRetryAfter,
  PluginHttp,
  type FetchLike,
} from "../../src/plugin/http.js";
import { CookieJar, restoreJar, serializeJar } from "../../src/plugin/cookies.js";
import { FakeClock } from "../helpers.js";

function setup(fetchImpl: FetchLike, userAgent?: { value: string; reason: string }) {
  const clock = new FakeClock();
  const waits: number[] = [];
  const limiter = new HostLimiter(clock, (ms) => {
    waits.push(ms);
    clock.advance(ms);
    return Promise.resolve();
  });
  const policy = {
    limits: { "*": { intervalMs: 1000, burst: 2 } },
    ...(userAgent === undefined ? {} : { userAgent }),
  };
  return { http: new PluginHttp(policy, limiter, clock, fetchImpl), waits, clock };
}

const ok: FetchLike = () => Promise.resolve(new Response('{"a":1}', { status: 200 }));

describe("plug-in HTTP client", () => {
  it("lets a burst through, then paces requests per host", async () => {
    const { http, waits } = setup(ok);
    const url = new URL("https://carrier.example.invalid/api");
    await http.request(url);
    await http.request(url);
    await http.request(url);
    await http.request(url);
    expect(waits).toEqual([1000, 1000]);
    await http.request(new URL("https://other.example.invalid/"));
    expect(waits).toEqual([1000, 1000]);
  });

  it("sends an honest User-Agent unless the plug-in documents why it needs another", async () => {
    const seen: (string | null)[] = [];
    const capture: FetchLike = (_url, init) => {
      seen.push(new Headers(init.headers).get("user-agent"));
      return Promise.resolve(new Response("ok"));
    };
    await setup(capture).http.request(new URL("https://a.example.invalid/"));
    await setup(capture, {
      value: "Browser/1",
      reason: "resets connections otherwise",
    }).http.request(new URL("https://a.example.invalid/"));
    expect(seen).toEqual([DEFAULT_USER_AGENT, "Browser/1"]);
  });

  it("turns 429 and 503 with Retry-After into RateLimitedError", async () => {
    const limited: FetchLike = () =>
      Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await expect(
      setup(limited).http.request(new URL("https://a.example.invalid/")),
    ).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSeconds: 120 });
    const busy: FetchLike = () =>
      Promise.resolve(new Response("", { status: 503, headers: { "retry-after": "30" } }));
    await expect(
      setup(busy).http.request(new URL("https://a.example.invalid/")),
    ).rejects.toBeInstanceOf(RateLimitedError);
    const plain503: FetchLike = () => Promise.resolve(new Response("down", { status: 503 }));
    await expect(
      setup(plain503).http.request(new URL("https://a.example.invalid/")),
    ).resolves.toMatchObject({ status: 503 });
  });

  it("wraps network failures as transient errors", async () => {
    const broken: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      setup(broken).http.request(new URL("https://a.example.invalid/")),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("refuses responses larger than the cap", async () => {
    const big: FetchLike = () => Promise.resolve(new Response("x".repeat(2048)));
    await expect(
      setup(big).http.request(new URL("https://a.example.invalid/"), { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("keeps cookies across redirects and only follows allowed hosts", async () => {
    const seenCookies: (string | null)[] = [];
    const site: FetchLike = (url, init) => {
      seenCookies.push(new Headers(init.headers).get("cookie"));
      if (url.pathname === "/login") {
        return Promise.resolve(
          new Response("", {
            status: 302,
            headers: {
              location: "https://www.example.invalid/home",
              "set-cookie": "session=abc; Path=/; Domain=example.invalid; Secure",
            },
          }),
        );
      }
      if (url.pathname === "/leave") {
        return Promise.resolve(
          new Response("", { status: 302, headers: { location: "https://evil.invalid/" } }),
        );
      }
      return Promise.resolve(new Response("welcome"));
    };
    const jar = new CookieJar();
    const result = await setup(site).http.request(new URL("https://login.example.invalid/login"), {
      jar,
      method: "POST",
      body: "x=1",
    });
    expect(result).toMatchObject({
      status: 200,
      body: "welcome",
      url: "https://www.example.invalid/home",
    });
    expect(seenCookies).toEqual([null, "session=abc"]);
    await expect(
      setup(site).http.request(new URL("https://www.example.invalid/leave"), { jar }),
    ).rejects.toBeInstanceOf(TransientError);
    // The jar survives a round trip through the session store format.
    expect(
      await restoreJar(serializeJar(jar)).getCookieString("https://www.example.invalid/"),
    ).toBe("session=abc");
    expect(await restoreJar("garbage").getCookieString("https://www.example.invalid/")).toBe("");
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    expect(parseRetryAfter("90", now)).toBe(90);
    expect(parseRetryAfter("Wed, 18 Nov 2026 12:02:00 GMT", now)).toBe(120);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
