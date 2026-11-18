import type { BaseContext } from "../../src/engine/registry.js";
import type { HttpPolicy } from "../../src/plugin/http.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

export type Reply =
  { status: number; body: string; type?: string; headers?: Record<string, string> } | Error;

/** Serves scripted replies in order and records each request's method and URL. */
export function scripted(replies: Reply[]): {
  fetchImpl: FetchLike;
  calls: { method: string; url: URL }[];
} {
  const calls: { method: string; url: URL }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ method: init.method ?? "GET", url });
    const reply = replies.shift() ?? { status: 404, body: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": reply.type ?? "application/json", ...reply.headers },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** A plug-in context for keyless tracking sources; `unknown` collects reported keys. */
export function keylessContext(
  policy: HttpPolicy,
  fetchImpl: FetchLike,
): { base: BaseContext; unknown: { kind: string; key: string }[] } {
  const clock = new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const unknown: { kind: string; key: string }[] = [];
  const base: BaseContext = {
    sourceId: "s1",
    http: new PluginHttp(policy, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (kind, key) => {
      unknown.push({ kind, key });
    },
  };
  return { base, unknown };
}
