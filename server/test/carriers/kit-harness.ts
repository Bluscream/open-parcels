import type { CarrierPlugin, FetchResult, PluginContext } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

export interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

/** Answers one request; return undefined to fall through to the next route. */
export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** A route that answers requests whose path (and query) contains `fragment`. */
export function on(fragment: string, ...answers: (Response | Error)[]): Route {
  return (url) => {
    if (!`${url.pathname}${url.search}`.includes(fragment)) {
      return undefined;
    }
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return answer?.clone();
  };
}

/** A fake network and context for one carrier plug-in. */
export class World<Config, Secret> {
  readonly calls: Call[] = [];
  readonly unknown: string[] = [];
  readonly clock = new FakeClock();
  routes: Route[] = [];
  stored: unknown = null;
  readonly http: PluginHttp;

  constructor(private readonly plugin: CarrierPlugin<Config, Secret>) {
    const fetchImpl: FetchLike = async (url, init) => {
      this.calls.push({ url, init });
      for (const route of this.routes) {
        const answer = await route(url, init);
        if (answer !== undefined) {
          return answer;
        }
      }
      return new Response("no route", { status: 599 });
    };
    const limiter = new HostLimiter(this.clock, (ms) => {
      this.clock.advance(ms);
      return Promise.resolve();
    });
    this.http = new PluginHttp(plugin.http, limiter, this.clock, fetchImpl);
  }

  context(config: Config, secret: Secret): PluginContext<Config, Secret> {
    return {
      sourceId: "source-1",
      config,
      secret,
      http: this.http,
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

  track(codes: readonly string[], config: Config, secret: Secret): Promise<FetchResult> {
    if (this.plugin.track === undefined) {
      throw new Error(`${this.plugin.id} has no tracking source`);
    }
    return this.plugin.track(this.context(config, secret), codes);
  }

  fetchAccount(config: Config, secret: Secret): Promise<FetchResult> {
    if (this.plugin.fetchAccount === undefined) {
      throw new Error(`${this.plugin.id} has no account source`);
    }
    return this.plugin.fetchAccount(this.context(config, secret));
  }

  paths(): string[] {
    return this.calls.map((c) => `${c.init.method ?? "GET"} ${c.url.hostname}${c.url.pathname}`);
  }
}

export function bodyOf(call: Call | undefined): string {
  const body = call?.init.body;
  return body instanceof URLSearchParams ? body.toString() : typeof body === "string" ? body : "";
}
