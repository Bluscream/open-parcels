import { register, type BaseContext, type RegisteredPlugin } from "../../src/engine/registry.js";
import type { CarrierPlugin } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

export type Reply = { status: number; body: unknown } | Error;

/** Serves scripted replies in order and records every request. */
export interface Scripted {
  readonly fetchImpl: FetchLike;
  readonly calls: { url: URL; init: RequestInit }[];
}

export interface Harness {
  readonly registered: RegisteredPlugin;
  readonly base: BaseContext;
  readonly unknown: string[];
}

export function scripted(replies: Reply[]): Scripted {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? { status: 500, body: {} };
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

/** A registered keyless plug-in plus a context whose limiter advances a fake clock. */
export function harness<C, S>(plugin: CarrierPlugin<C, S>, fetchImpl: FetchLike): Harness {
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
  return { registered: register(plugin), base, unknown };
}
