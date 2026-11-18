import { register, type BaseContext, type RegisteredPlugin } from "../../src/engine/registry.js";
import type { CarrierPlugin } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** One scripted answer: JSON (or raw text when `body` is a string), or a network error. */
export type Reply = { status: number; body: unknown; contentType?: string } | Error;

export interface Call {
  readonly key: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/**
 * Routes requests by "METHOD host/path" to scripted replies, used in order. Anything unscripted
 * answers 404 with an empty JSON object.
 */
export function fakeRoutes(routes: Record<string, Reply[]>): {
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
      body:
        typeof init.body === "string"
          ? init.body
          : init.body instanceof URLSearchParams
            ? init.body.toString()
            : null,
    });
    const reply = routes[key]?.shift() ?? { status: 404, body: {} };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(text, {
        status: reply.status,
        headers: { "content-type": reply.contentType ?? "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

export interface Harness {
  readonly plugin: RegisteredPlugin;
  readonly base: BaseContext;
  readonly unknown: string[];
  readonly saved: unknown[];
}

/** A registered plug-in with a fake clock, an instant limiter and an in-memory session. */
export function harness<C, S>(
  carrier: CarrierPlugin<C, S>,
  fetchImpl: FetchLike,
  session: unknown = null,
): Harness {
  const clock = new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const unknown: string[] = [];
  const saved: unknown[] = [];
  let current = session;
  const base: BaseContext = {
    sourceId: "s1",
    http: new PluginHttp(carrier.http, limiter, clock, fetchImpl),
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
  return { plugin: register(carrier), base, unknown, saved };
}
