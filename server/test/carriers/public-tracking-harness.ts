import type { CarrierPlugin } from "../../src/plugin/api.js";
import type { BaseContext } from "../../src/engine/registry.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

export type Reply = { status: number; body: unknown } | Error;

/** Routes requests by "METHOD path" to scripted replies, used in order; unknown routes get 404. */
export function fakeCarrier(routes: Record<string, Reply[]>): {
  fetchImpl: FetchLike;
  calls: { key: string; body: string | null }[];
} {
  const calls: { key: string; body: string | null }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push({ key, body: typeof init.body === "string" ? init.body : null });
    const reply = routes[key]?.shift() ?? { status: 404, body: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** A context for a keyless tracking plug-in; `unknown` collects reported keys. */
export function trackingContext<C, S>(
  plugin: CarrierPlugin<C, S>,
  fetchImpl: FetchLike,
): { base: BaseContext; unknown: string[] } {
  const clock = new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const unknown: string[] = [];
  const base: BaseContext = {
    sourceId: "s1",
    http: new PluginHttp(plugin.http, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}
