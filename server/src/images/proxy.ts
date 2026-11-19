import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP, type LookupFunction } from "node:net";
import path from "node:path";
import type { Logger } from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import { hostAllowed, isPrivateAddress } from "../net/address.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export class ImageProxyError extends Error {
  override readonly name = "ImageProxyError";

  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export { isPrivateAddress };

export type Resolver = (host: string) => Promise<string[]>;
const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * DNS lookup for outgoing image requests that refuses private addresses at connect time. The
 * check before the request is not enough on its own: a host could resolve to a public address
 * for the check and to a private one for the connection (DNS rebinding).
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error !== null) {
      callback(error, "", 0);
      return;
    }
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    const first = allowed[0];
    if (first === undefined || allowed.length !== addresses.length) {
      callback(new Error(`Refusing to connect to a non-public address for ${hostname}.`), "", 0);
      return;
    }
    if (options.all === true) {
      callback(null, allowed);
      return;
    }
    callback(null, first.address, first.family);
  });
};

/** The parts of a fetch response the proxy uses; lets tests supply a fake. */
export interface MinimalResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  /** Read as a stream when present, so an oversized body is cut off instead of buffered. */
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ImageFetch = (
  url: URL,
  init: { headers: Record<string, string> },
) => Promise<MinimalResponse>;

const guardedAgent = new Agent({ connect: { lookup: publicOnlyLookup } });
const guardedFetch: ImageFetch = (url, init) =>
  undiciFetch(url, {
    headers: init.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    dispatcher: guardedAgent,
  });

export interface ImageProxyOptions {
  readonly secretKey: Buffer;
  readonly cacheDir: string;
  readonly logger: Logger;
  readonly maxCacheBytes?: number;
  readonly fetchImpl?: ImageFetch;
  readonly resolve?: Resolver;
  /**
   * Hosts images may come from: the union of the carriers' `imageHosts`. Every hop, redirects
   * included, must match. Unset allows any public host (tests only).
   */
  readonly allowedHosts?: () => Iterable<string>;
}

/**
 * Reads at most `cap` bytes: a declared Content-Length over the cap is refused before reading,
 * and a stream is cancelled as soon as it passes the cap, so nothing large is ever buffered.
 */
export async function readCapped(response: MinimalResponse, cap: number): Promise<Buffer> {
  const tooLarge = (): ImageProxyError => new ImageProxyError(502, "The image is too large.");
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === undefined || response.body === null) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > cap) {
      throw tooLarge();
    }
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

/**
 * Serves remote item pictures and delivery photos from this server, so clients never load
 * third-party or carrier-signed links. Addresses are signed: the proxy only fetches what the
 * server itself handed out.
 */
export class ImageProxy {
  readonly #key: Buffer;
  readonly #cacheDir: string;
  readonly #maxCacheBytes: number;
  readonly #fetch: ImageFetch;
  readonly #resolve: Resolver;
  readonly #pending = new Map<string, Promise<{ body: Buffer; type: string }>>();

  constructor(private readonly options: ImageProxyOptions) {
    this.#key = Buffer.from(
      hkdfSync("sha256", options.secretKey, Buffer.alloc(0), "open-parcels image proxy", 32),
    );
    this.#cacheDir = options.cacheDir;
    this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
    this.#fetch = options.fetchImpl ?? guardedFetch;
    this.#resolve = options.resolve ?? dnsResolver;
    mkdirSync(this.#cacheDir, { recursive: true });
  }

  #sign(token: string): string {
    return createHmac("sha256", this.#key).update(token).digest("base64url").slice(0, 32);
  }

  /** The proxied path for a remote image, or null when the URL is not an https URL. */
  pathFor(remote: string | null): string | null {
    if (remote === null) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") {
      return null;
    }
    const token = Buffer.from(url.toString(), "utf8").toString("base64url");
    return `/img/${token}.${this.#sign(token)}`;
  }

  /** Verifies the signature and returns the image, from the cache or freshly fetched. */
  async get(token: string, signature: string): Promise<{ body: Buffer; type: string }> {
    const expected = Buffer.from(this.#sign(token));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new ImageProxyError(404, "Unknown image.");
    }
    const remote = new URL(Buffer.from(token, "base64url").toString("utf8"));
    const name = createHash("sha256").update(remote.toString()).digest("hex");
    const cached = await this.#readCache(name);
    if (cached !== undefined) {
      return cached;
    }
    // Concurrent requests for one image share one download.
    let pending = this.#pending.get(name);
    if (pending === undefined) {
      pending = this.#download(remote, name).finally(() => this.#pending.delete(name));
      this.#pending.set(name, pending);
    }
    return pending;
  }

  async #readCache(name: string): Promise<{ body: Buffer; type: string } | undefined> {
    try {
      const [body, type] = await Promise.all([
        readFile(path.join(this.#cacheDir, `${name}.bin`)),
        readFile(path.join(this.#cacheDir, `${name}.type`), "utf8"),
      ]);
      return { body, type };
    } catch (error) {
      // A missing file is an ordinary cache miss; anything else is a real problem.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #assertPublic(url: URL): Promise<void> {
    if (url.protocol !== "https:") {
      throw new ImageProxyError(502, "Only https images are proxied.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const allowed = this.options.allowedHosts?.();
    if (allowed !== undefined && !hostAllowed(host, allowed)) {
      throw new ImageProxyError(502, "The image host is not on any carrier's allow-list.");
    }
    const addresses = isIP(host) === 0 ? await this.#resolve(host) : [host];
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new ImageProxyError(502, "The image host is not a public address.");
    }
  }

  async #download(start: URL, name: string): Promise<{ body: Buffer; type: string }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await this.#assertPublic(url);
      const response = await this.#fetch(url, { headers: { accept: "image/*" } });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        throw new ImageProxyError(502, `The image host answered ${response.status}.`);
      }
      const type =
        (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ALLOWED_TYPES.has(type)) {
        throw new ImageProxyError(502, "The remote file is not a supported image.");
      }
      const body = await readCapped(response, MAX_IMAGE_BYTES);
      await this.#store(name, body, type);
      return { body, type };
    }
    throw new ImageProxyError(502, "Too many redirects.");
  }

  async #store(name: string, body: Buffer, type: string): Promise<void> {
    const file = path.join(this.#cacheDir, `${name}.bin`);
    await writeFile(`${file}.tmp`, body);
    await rename(`${file}.tmp`, file);
    await writeFile(path.join(this.#cacheDir, `${name}.type`), type);
  }

  /** Deletes the least recently written images until the cache fits its budget. */
  async prune(): Promise<number> {
    const entries = await readdir(this.#cacheDir);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".bin"))
        .map(async (entry) => {
          const info = await stat(path.join(this.#cacheDir, entry));
          return { entry, size: info.size, mtime: info.mtimeMs };
        }),
    );
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.#maxCacheBytes) {
        break;
      }
      const base = file.entry.slice(0, -4);
      await unlink(path.join(this.#cacheDir, file.entry));
      await unlink(path.join(this.#cacheDir, `${base}.type`)).catch((error: unknown) => {
        this.options.logger.debug({ err: error }, "Image type file was already gone.");
      });
      total -= file.size;
      removed += 1;
    }
    return removed;
  }
}
