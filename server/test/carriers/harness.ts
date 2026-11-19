/**
 * The one test harness for carrier plug-ins: a scripted fake network, a plug-in context over a
 * fake clock and an in-memory session, and `World`, which wires both to a carrier. Fixtures used
 * with it are always made up.
 */
import { register, type BaseContext, type RegisteredPlugin } from "../../src/engine/registry.js";
import { NOT_FILED_AS_TRACKED } from "../../src/engine/tracked.js";
import type { CarrierPlugin, FetchResult, PluginContext } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp, type FetchLike, type HttpPolicy } from "../../src/plugin/http.js";
import { FakeClock } from "../helpers.js";

/** One recorded request. `key` is `METHOD host/path` (hostname, no port, no query). */
export interface Call {
  readonly key: string;
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  /** The body as text: strings and form bodies; null for anything else. */
  readonly body: string | null;
  readonly init: RequestInit;
}

/** A scripted answer: a response, or an error the fetch rejects with. */
export type Answer = Response | Error;

/** Answers a request; undefined falls through to the next route. */
export type Route = (call: Call) => Answer | Promise<Answer> | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

/** A body sent as is, with only the headers given (no content type unless set). */
export function raw(
  body: string | Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

/** Answers requests whose key is exactly `METHOD host/path`, with the replies in order. */
export function on(key: string, ...replies: Answer[]): Route {
  return (call) => (call.key === key ? replies.shift() : undefined);
}

/** Like `on`, but the key only has to start with `prefix`. */
export function onPrefix(prefix: string, ...replies: Answer[]): Route {
  return (call) => (call.key.startsWith(prefix) ? replies.shift() : undefined);
}

/**
 * Answers requests whose path and query contain `fragment`. Answers are used in order and the
 * last one repeats, so a single answer serves every matching request.
 */
export function onFragment(fragment: string, ...answers: Answer[]): Route {
  return (call) => {
    if (!`${call.url.pathname}${call.url.search}`.includes(fragment)) {
      return undefined;
    }
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return answer instanceof Response ? answer.clone() : answer;
  };
}

/** Answers every request with the next reply, whatever it asks for. */
export function inOrder(...replies: Answer[]): Route {
  return () => replies.shift();
}

/**
 * Answers by a table of `METHOD <where>` keys, each with replies used in order. `where` is the
 * hostname and path by default, `host` adds the port, `path` leaves the host out.
 */
export function routeTable(
  table: Record<string, Answer[]>,
  keyBy: "hostname" | "host" | "path" = "hostname",
): Route {
  return (call) => {
    const where =
      keyBy === "path"
        ? call.url.pathname
        : `${keyBy === "host" ? call.url.host : call.url.hostname}${call.url.pathname}`;
    return table[`${call.method} ${where}`]?.shift();
  };
}

function bodyText(body: RequestInit["body"]): string | null {
  if (typeof body === "string") {
    return body;
  }
  return body instanceof URLSearchParams ? body.toString() : null;
}

/** What an unanswered request gets. Default: HTTP 599 "no route", so nothing passes silently. */
export type Fallback = () => Response;

export const noRoute: Fallback = () => new Response("no route", { status: 599 });

export interface FakeNetwork {
  readonly fetchImpl: FetchLike;
  readonly calls: Call[];
  /** "METHOD host/path" of every request, in order. */
  requests(): string[];
}

/** A fetch that records every request and asks the routes in order. */
export function fakeNetwork(
  routes: Route[] | (() => readonly Route[]),
  fallback: Fallback = noRoute,
): FakeNetwork {
  const calls: Call[] = [];
  const current = typeof routes === "function" ? routes : () => routes;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init.method ?? "GET";
    const call: Call = {
      key: `${method} ${url.hostname}${url.pathname}`,
      method,
      url,
      headers: new Headers(init.headers),
      body: bodyText(init.body),
      init,
    };
    calls.push(call);
    for (const route of current()) {
      const answer = await route(call);
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer !== undefined) {
        return answer;
      }
    }
    return fallback();
  };
  return { fetchImpl, calls, requests: () => calls.map((call) => call.key) };
}

export interface ContextOptions {
  /** What the session store holds at the start. */
  readonly session?: unknown;
  readonly clock?: FakeClock;
}

export interface FakeContext {
  readonly base: BaseContext;
  readonly clock: FakeClock;
  /** Every value the plug-in saved to its session, in order. */
  readonly saved: unknown[];
  /** Reported unknowns as `kind:key`. */
  readonly unknown: string[];
  /** Reported unknowns as the key alone. */
  readonly unknownKeys: string[];
  /** Reported unknowns as kind and key. */
  readonly reports: { kind: string; key: string }[];
  readonly warnings: string[];
  /** What the session store holds now. */
  stored(): unknown;
  /** Replaces what the session store holds, as if saved earlier. */
  restore(value: unknown): void;
}

/** A plug-in context over a fake clock whose limiter waits by advancing the clock. */
export function fakeContext(
  policy: HttpPolicy,
  fetchImpl: FetchLike,
  options: ContextOptions = {},
): FakeContext {
  const clock = options.clock ?? new FakeClock();
  const limiter = new HostLimiter(clock, (ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  const saved: unknown[] = [];
  const unknown: string[] = [];
  const unknownKeys: string[] = [];
  const reports: { kind: string; key: string }[] = [];
  const warnings: string[] = [];
  let current: unknown = options.session ?? null;
  const base: BaseContext = {
    sourceId: "source-1",
    http: new PluginHttp(policy, limiter, clock, fetchImpl),
    clock,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (_context, message) => {
        warnings.push(message);
      },
    },
    session: {
      load: () => current,
      save: (value) => {
        current = value;
        saved.push(value);
        return Promise.resolve();
      },
    },
    reportUnknown: (kind, key) => {
      unknown.push(`${kind}:${key}`);
      unknownKeys.push(key);
      reports.push({ kind, key });
    },
  };
  return {
    base,
    clock,
    saved,
    unknown,
    unknownKeys,
    reports,
    warnings,
    stored: () => current,
    restore: (value) => {
      current = value;
    },
  };
}

/**
 * A carrier wired to a fake network and context. `routes` can be set up front or changed between
 * steps. `track` and `fetchAccount` go through the registry, which validates config and secret as
 * the app does; `context` gives a typed context for calling the plug-in directly.
 */
export class World<Config = unknown, Secret = unknown> {
  readonly plugin: RegisteredPlugin;
  readonly carrier: CarrierPlugin<Config, Secret>;
  routes: Route[];
  readonly #network: FakeNetwork;
  readonly #context: FakeContext;

  constructor(
    carrier: CarrierPlugin<Config, Secret>,
    routes: Route[] = [],
    options: ContextOptions = {},
  ) {
    this.carrier = carrier;
    this.plugin = register(carrier);
    this.routes = routes;
    this.#network = fakeNetwork(() => this.routes);
    this.#context = fakeContext(carrier.http, this.#network.fetchImpl, options);
  }

  get calls(): Call[] {
    return this.#network.calls;
  }

  get clock(): FakeClock {
    return this.#context.clock;
  }

  /** Reported unknowns as `kind:key`. */
  get unknown(): string[] {
    return this.#context.unknown;
  }

  get unknownKeys(): string[] {
    return this.#context.unknownKeys;
  }

  get warnings(): string[] {
    return this.#context.warnings;
  }

  get saved(): unknown[] {
    return this.#context.saved;
  }

  /** What the session store holds now. */
  get stored(): unknown {
    return this.#context.stored();
  }

  set stored(value: unknown) {
    this.#context.restore(value);
  }

  base(): BaseContext {
    return this.#context.base;
  }

  context(config: Config, secret: Secret): PluginContext<Config, Secret> {
    return { ...this.#context.base, config, secret };
  }

  /**
   * Tracks codes through the registry, and fails when a snapshot is filed under anything but a code
   * that was asked for: the carrier's echo belongs in `externalRef`, never in `barcode`, or the
   * tracked code reads as not found and a second parcel appears. Every carrier test runs this.
   */
  async track(
    codes: readonly string[],
    config: unknown = {},
    secret: unknown = null,
  ): Promise<FetchResult> {
    const before = this.warnings.length;
    const result = await this.plugin.track(this.base(), config, secret, codes);
    if (this.warnings.slice(before).includes(NOT_FILED_AS_TRACKED)) {
      throw new Error(
        `${this.carrier.id}: track() filed an answer under something other than a tracked code (${codes.join(", ")}).`,
      );
    }
    assertFiledAsTracked(this.carrier.id, codes, result);
    return result;
  }

  fetchAccount(config: unknown = {}, secret: unknown = null): Promise<FetchResult> {
    return this.plugin.fetchAccount(this.base(), config, secret);
  }

  /** "METHOD host/path" of every request, in order. */
  requests(): string[] {
    return this.#network.requests();
  }
}

/** Throws unless every snapshot of a lookup is filed under one of the codes asked for. */
export function assertFiledAsTracked(
  carrier: string,
  codes: readonly string[],
  result: FetchResult,
): void {
  const asked = new Set(codes);
  const stray = result.snapshots.map((found) => found.barcode).filter((code) => !asked.has(code));
  if (stray.length > 0) {
    throw new Error(
      `${carrier}: track() filed ${stray.join(", ")} instead of a tracked code (${codes.join(", ")}).`,
    );
  }
}

/** Made-up secret values built from parts, so the pre-commit secret check stays quiet. */
export function madeUp(...parts: string[]): string {
  return ["test", ...parts].join("-");
}

/** The form a request sent, for token and postback requests. */
export function formOf(call: Call | undefined): URLSearchParams {
  return new URLSearchParams(call?.body ?? "");
}
