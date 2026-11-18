import type { BaseContext } from "../../src/engine/registry.js";
import type { HttpPolicy } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** A scripted reply: a body with a status and content type, or a thrown network error. */
export type Reply = { status: number; body: string; type?: string } | Error;

export interface Call {
  readonly url: URL;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Headers;
}

/** Answers every request with the next reply from `replies`, in order; 404 once they run out. */
export function scripted(replies: Reply[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      headers: new Headers(init.headers),
    });
    const reply = replies.shift() ?? { status: 404, body: "" };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": reply.type ?? "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

export const json = (body: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(body),
});

/** A plug-in context for public tracking sources, recording what was reported as unknown. */
export function trackingContext(
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
    reportUnknown: (kind, key) => {
      unknown.push(`${kind}:${key}`);
    },
  };
  return { base, unknown };
}
