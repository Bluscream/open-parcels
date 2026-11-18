import type { BaseContext } from "../../src/engine/registry.js";
import { HostLimiter, PluginHttp, type FetchLike, type HttpPolicy } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** A scripted reply: JSON by default, `raw` sends the string (or bytes) as is. */
export type Reply =
  | {
      status: number;
      body?: unknown;
      raw?: string | Uint8Array;
      headers?: Record<string, string>;
    }
  | Error;

export interface Call {
  readonly key: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/**
 * Routes requests by "METHOD host/path" to scripted replies, used in order. A route without a
 * reply left answers 404 with an empty body.
 */
export function fakeFetch(routes: Record<string, Reply[]>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const key = `${init.method ?? "GET"} ${url.hostname}${url.pathname}`;
    calls.push({
      key,
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
    });
    const reply = routes[key]?.shift() ?? { status: 404, raw: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    const payload = reply.raw ?? JSON.stringify(reply.body ?? null);
    return Promise.resolve(
      new Response(payload, {
        status: reply.status,
        headers: {
          "content-type": reply.raw === undefined ? "application/json" : "text/html",
          ...reply.headers,
        },
      }),
    );
  };
  return { fetchImpl, calls };
}

export interface FakeContext {
  readonly base: BaseContext;
  readonly saved: unknown[];
  readonly unknown: string[];
  readonly clock: FakeClock;
}

export function fakeContext(
  policy: HttpPolicy,
  fetchImpl: FetchLike,
  session: unknown = null,
): FakeContext {
  const clock = new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const saved: unknown[] = [];
  const unknown: string[] = [];
  let current = session;
  const base: BaseContext = {
    sourceId: "s1",
    http: new PluginHttp(policy, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: {
      load: () => current,
      save: (value) => {
        current = value;
        saved.push(value);
        return Promise.resolve();
      },
    },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, saved, unknown, clock };
}
