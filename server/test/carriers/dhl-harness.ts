import { dhl } from "../../src/carriers/dhl/index.js";
import type { FetchResult, PluginContext } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

export type Secret = { refreshToken?: string; apiKey?: string } | null;

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

/** A made-up ID token carrying the account claim (or not). */
export function idToken(withAccountClaim = true, tag = "a"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = withAccountClaim
    ? { sub: `user-${tag}`, post_number: "0000000000" }
    : { sub: "x" };
  return `${encode({ alg: "none" })}.${encode(claims)}.c2ln`;
}

export class World {
  readonly calls: Call[] = [];
  readonly unknown: string[] = [];
  readonly clock = new FakeClock();
  routes: Route[] = [];
  stored: unknown = null;
  readonly http: PluginHttp;

  constructor() {
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
    this.http = new PluginHttp(dhl.http, limiter, this.clock, fetchImpl);
  }

  context(secret: Secret): PluginContext<Record<string, unknown>, Secret> {
    return {
      sourceId: "source-1",
      config: {},
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

  hosts(): string[] {
    return this.calls.map((c) => `${c.init.method ?? "GET"} ${c.url.hostname}${c.url.pathname}`);
  }
}

export function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

/** The form a call sent, for token requests. */
export function formOf(call: Call | undefined): URLSearchParams {
  const body = call?.init.body;
  return body instanceof URLSearchParams
    ? body
    : new URLSearchParams(typeof body === "string" ? body : "");
}

type Context = PluginContext<Record<string, unknown>, Secret>;

export function track(context: Context, codes: readonly string[]): Promise<FetchResult> {
  if (dhl.track === undefined) {
    throw new Error("DHL has no tracking source");
  }
  return dhl.track(context, codes);
}

export function fetchAccount(context: Context): Promise<FetchResult> {
  if (dhl.fetchAccount === undefined) {
    throw new Error("DHL has no account source");
  }
  return dhl.fetchAccount(context);
}

export { dhl };
