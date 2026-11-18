import { register, type BaseContext, type RegisteredPlugin } from "../../src/engine/registry.js";
import type { CarrierPlugin, FetchResult } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** One recorded request. */
export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/** Answers a request; undefined falls through to the next route. */
export type Route = (call: Call) => Response | Error | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

/** A route for "METHOD host/path" (query ignored) that hands out its replies in order. */
export function on(key: string, ...replies: (Response | Error)[]): Route {
  return (call) => {
    const target = `${call.method} ${call.url.hostname}${call.url.pathname}`;
    return target === key ? replies.shift() : undefined;
  };
}

/** A carrier wired to scripted HTTP answers, a fake clock and an in-memory session. */
export class World {
  readonly calls: Call[] = [];
  readonly unknown: string[] = [];
  readonly warnings: string[] = [];
  readonly clock = new FakeClock();
  readonly plugin: RegisteredPlugin;
  routes: Route[] = [];
  stored: unknown = null;
  readonly #http: PluginHttp;

  constructor(plugin: RegisteredPlugin) {
    this.plugin = plugin;
    const fetchImpl: FetchLike = (url, init) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        headers: new Headers(init.headers),
        body:
          typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : null,
      };
      this.calls.push(call);
      for (const route of this.routes) {
        const answer = route(call);
        if (answer instanceof Error) {
          return Promise.reject(answer);
        }
        if (answer !== undefined) {
          return Promise.resolve(answer);
        }
      }
      return Promise.resolve(new Response("no route", { status: 599 }));
    };
    const limiter = new HostLimiter(this.clock, (ms) => {
      this.clock.advance(ms);
      return Promise.resolve();
    });
    this.#http = new PluginHttp(this.plugin.http, limiter, this.clock, fetchImpl);
  }

  base(): BaseContext {
    return {
      sourceId: "source-1",
      http: this.#http,
      clock: this.clock,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (_context, message) => {
          this.warnings.push(message);
        },
      },
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
    return this.plugin.track(this.base(), config, secret, codes);
  }

  fetchAccount(config: unknown = {}, secret: unknown = null): Promise<FetchResult> {
    return this.plugin.fetchAccount(this.base(), config, secret);
  }

  /** "METHOD host/path" of every request, in order. */
  requests(): string[] {
    return this.calls.map((c) => `${c.method} ${c.url.hostname}${c.url.pathname}`);
  }
}

export function world<Config, Secret>(carrier: CarrierPlugin<Config, Secret>): World {
  return new World(register(carrier));
}

/** Made-up secret values built from parts, so the pre-commit secret check stays quiet. */
export function madeUp(...parts: string[]): string {
  return ["test", ...parts].join("-");
}
