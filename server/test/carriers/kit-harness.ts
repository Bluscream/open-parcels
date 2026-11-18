import type { BaseContext } from "../../src/engine/registry.js";
import type { HttpPolicy } from "../../src/plugin/http.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** A scripted answer: JSON (or a raw body) with a status, or a thrown network error. */
export type Reply =
  | {
      readonly status: number;
      readonly body?: unknown;
      readonly raw?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | Error;

export interface Call {
  readonly key: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/**
 * Routes requests by `METHOD host/path` to scripted replies, used in order. Unrouted requests
 * answer 599 so a test never silently talks to something it did not plan for.
 */
export function scripted(routes: Record<string, Reply[]>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const key = `${init.method ?? "GET"} ${url.host}${url.pathname}`;
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : null;
    calls.push({ key, url, headers: new Headers(init.headers), body });
    const reply = routes[key]?.shift() ?? { status: 599, raw: "unrouted" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    const raw = reply.raw ?? JSON.stringify(reply.body ?? null);
    return Promise.resolve(
      new Response(raw, {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** A plug-in context over a fake clock and scripted network, recording saves and unknowns. */
export function harness(
  policy: HttpPolicy,
  fetchImpl: FetchLike,
  session: unknown = null,
): { base: BaseContext; saved: unknown[]; unknown: string[]; clock: FakeClock } {
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
    reportUnknown: (kind, key) => {
      unknown.push(`${kind}:${key}`);
    },
  };
  return { base, saved, unknown, clock };
}
