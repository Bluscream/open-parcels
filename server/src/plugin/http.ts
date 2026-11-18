import type { Clock } from "../clock.js";
import { RateLimitedError, TransientError } from "./errors.js";

export const DEFAULT_USER_AGENT = "open-parcels/2 (+https://github.com/Bluscream/open-parcels)";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Pacing for one host: at most `burst` requests back to back, refilled one per `intervalMs`. */
export interface HostLimit {
  readonly intervalMs: number;
  readonly burst: number;
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/** Sleep that tests can replace; the scheduler's fake clock does not advance real timers. */
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Token bucket per host, shared by every source of the same carrier. */
export class HostLimiter {
  readonly #buckets = new Map<
    string,
    { tokens: number; updatedAt: number; queue: Promise<void> }
  >();

  constructor(
    private readonly clock: Clock,
    private readonly sleep: Sleep,
  ) {}

  /** Resolves when a request to `host` may be sent. Calls for one host are served in order. */
  acquire(host: string, limit: HostLimit): Promise<void> {
    const bucket = this.#buckets.get(host) ?? {
      tokens: limit.burst,
      updatedAt: this.clock.now().getTime(),
      queue: Promise.resolve(),
    };
    this.#buckets.set(host, bucket);
    const turn = bucket.queue.then(async () => {
      const now = this.clock.now().getTime();
      bucket.tokens = Math.min(
        limit.burst,
        bucket.tokens + (now - bucket.updatedAt) / limit.intervalMs,
      );
      bucket.updatedAt = now;
      if (bucket.tokens < 1) {
        const waitMs = Math.ceil((1 - bucket.tokens) * limit.intervalMs);
        await this.sleep(waitMs);
        bucket.tokens = 1;
        bucket.updatedAt = this.clock.now().getTime();
      }
      bucket.tokens -= 1;
    });
    bucket.queue = turn;
    return turn;
  }
}

/** Parses Retry-After: either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

export interface HttpPolicy {
  /** Limits per host name; `*` applies to hosts not listed. */
  readonly limits: Readonly<Record<string, HostLimit>>;
  /**
   * Only set when the carrier refuses an honest client User-Agent. `reason` documents what the
   * carrier does without it and is shown in diagnostics.
   */
  readonly userAgent?: { readonly value: string; readonly reason: string };
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | URLSearchParams;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Follow redirects automatically. Off when a plug-in has to inspect them (allow-listing). */
  readonly redirect?: "follow" | "manual";
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly url: string;
  readonly body: string;
  json(): unknown;
}

const DEFAULT_LIMIT: HostLimit = { intervalMs: 2_000, burst: 3 };

/** The only way plug-ins reach the network. */
export class PluginHttp {
  constructor(
    private readonly policy: HttpPolicy,
    private readonly limiter: HostLimiter,
    private readonly clock: Clock,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async request(url: URL, options: RequestOptions = {}): Promise<HttpResponse> {
    const limit = this.policy.limits[url.hostname] ?? this.policy.limits["*"] ?? DEFAULT_LIMIT;
    await this.limiter.acquire(url.hostname, limit);
    const headers = new Headers(options.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", this.policy.userAgent?.value ?? DEFAULT_USER_AGENT);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: options.redirect ?? "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TransientError(`Request to ${url.hostname} failed.`, { cause: error });
    }
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.clock.now());
    if (response.status === 429 || (response.status === 503 && retryAfter !== undefined)) {
      await response.body?.cancel();
      throw new RateLimitedError(
        `${url.hostname} asked us to slow down (HTTP ${response.status}).`,
        retryAfter,
      );
    }
    const body = await this.#readBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES, url);
    return {
      status: response.status,
      headers: response.headers,
      url: response.url,
      body,
      json: () => JSON.parse(body) as unknown,
    };
  }

  async #readBody(response: Response, maxBytes: number, url: URL): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return "";
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new TransientError(`Unexpected body chunk from ${url.hostname}.`);
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TransientError(`Response from ${url.hostname} exceeded ${maxBytes} bytes.`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
