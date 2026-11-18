import type { BaseContext } from "../../src/engine/registry.js";
import { HostLimiter, PluginHttp, type FetchLike, type HttpPolicy } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** A scripted reply: JSON body, raw text, or a network failure. */
export type Reply = { status: number; body?: unknown; text?: string } | Error;

export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/** Serves the replies in order and records every request. Runs out → HTTP 500. */
export function scripted(replies: Reply[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
    });
    const reply = replies.shift() ?? { status: 500, text: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    const body = reply.text ?? JSON.stringify(reply.body);
    return Promise.resolve(new Response(body, { status: reply.status }));
  };
  return { fetchImpl, calls };
}

/** A plug-in context for keyless tracking sources; `unknown` collects reported codes. */
export function keylessContext(
  policy: HttpPolicy,
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
    http: new PluginHttp(policy, limiter, clock, fetchImpl),
    clock,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    session: { load: () => null, save: () => Promise.resolve() },
    reportUnknown: (_kind, key) => {
      unknown.push(key);
    },
  };
  return { base, unknown };
}
