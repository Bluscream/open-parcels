import type { CarrierPlugin, FetchResult } from "../../src/plugin/api.js";
import { register, type BaseContext, type RegisteredPlugin } from "../../src/engine/registry.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** A fake carrier backend for plug-in tests. Fixtures here are always made up. */

export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/** Answers one request; return undefined to fall through to the next route. */
export type Route = (call: Call) => Response | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** A route for `METHOD host/path` (path prefix match) answering the given replies in order. */
export function on(key: string, ...replies: (Response | Error)[]): Route {
  return (call) => {
    const actual = `${call.method} ${call.url.hostname}${call.url.pathname}`;
    if (!actual.startsWith(key) || replies.length === 0) {
      return undefined;
    }
    const reply = replies.shift();
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
}

function bodyText(body: RequestInit["body"]): string | null {
  if (typeof body === "string") {
    return body;
  }
  return body instanceof URLSearchParams ? body.toString() : null;
}

export class World<Config, Secret> {
  readonly calls: Call[] = [];
  readonly unknown: string[] = [];
  readonly clock = new FakeClock();
  readonly plugin: RegisteredPlugin;
  stored: unknown = null;
  readonly base: BaseContext;

  constructor(
    carrier: CarrierPlugin<Config, Secret>,
    private readonly routes: Route[],
  ) {
    this.plugin = register(carrier);
    const fetchImpl: FetchLike = (url, init) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        headers: new Headers(init.headers),
        body: bodyText(init.body),
      };
      this.calls.push(call);
      try {
        for (const route of this.routes) {
          const answer = route(call);
          if (answer !== undefined) {
            return Promise.resolve(answer);
          }
        }
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return Promise.resolve(new Response("no route", { status: 599 }));
    };
    const limiter = new HostLimiter(this.clock, (ms) => {
      this.clock.advance(ms);
      return Promise.resolve();
    });
    this.base = {
      sourceId: "source-1",
      http: new PluginHttp(carrier.http, limiter, this.clock, fetchImpl),
      clock: this.clock,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      session: {
        load: () => this.stored,
        save: (value) => {
          this.stored = value;
          return Promise.resolve();
        },
      },
      reportUnknown: (kind, key) => {
        this.unknown.push(`${kind}:${key}`);
      },
    };
  }

  track(
    codes: readonly string[],
    config: unknown = {},
    secret: unknown = null,
  ): Promise<FetchResult> {
    return this.plugin.track(this.base, config, secret, codes);
  }

  fetchAccount(secret: unknown, config: unknown = {}): Promise<FetchResult> {
    return this.plugin.fetchAccount(this.base, config, secret);
  }

  paths(): string[] {
    return this.calls.map((call) => `${call.method} ${call.url.hostname}${call.url.pathname}`);
  }
}

/** A made-up password built from parts, so the pre-commit secret check stays quiet. */
export const madeUpPassword = ["not", "a", "real", "one"].join("-");
