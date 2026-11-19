import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Map tiles fetched through this server, following OpenStreetMap's tile usage policy: an
 * identifying User-Agent, at most two upstream connections, and a disk cache honoured for a week.
 * Browsers that strip the Referer (LibreWolf, privacy add-ons) are refused by the tile servers
 * when they ask directly, so the web UI always goes through here.
 */
export const TILE_UPSTREAM = "https://tile.openstreetmap.org";
export const TILE_MAX_ZOOM = 19;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPSTREAM = 2;
const MAX_TILE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;

export class TileError extends Error {
  override readonly name = "TileError";
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Tile {
  readonly body: Buffer;
  readonly cached: boolean;
}

export interface TileProxyOptions {
  readonly cacheDir: string;
  readonly userAgent: string;
  readonly upstream?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Tiles not refreshed for this long are deleted by `prune()`. */
  readonly maxAgeMs?: number;
  readonly maxCacheBytes?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;

/** Valid slippy-map coordinates only; anything else never reaches the network or the disk. */
export function validTile(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > TILE_MAX_ZOOM) {
    return false;
  }
  const size = 2 ** z;
  return x >= 0 && y >= 0 && x < size && y < size;
}

export class TileProxy {
  readonly #options: TileProxyOptions;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #inflight = new Map<string, Promise<Tile>>();

  constructor(options: TileProxyOptions) {
    this.#options = options;
  }

  async get(z: number, x: number, y: number): Promise<Tile> {
    if (!validTile(z, x, y)) {
      throw new TileError(400, "Not a map tile.");
    }
    const key = `${String(z)}/${String(x)}/${String(y)}`;
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const work = this.#load(z, x, y).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, work);
    return work;
  }

  async #load(z: number, x: number, y: number): Promise<Tile> {
    const file = path.join(this.#options.cacheDir, String(z), String(x), `${String(y)}.png`);
    const now = this.#options.now?.() ?? Date.now();
    const cached = await readCached(file);
    if (cached !== null && now - cached.mtimeMs < FRESH_MS) {
      return { body: cached.body, cached: true };
    }
    try {
      const body = await this.#fetchUpstream(z, x, y);
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, file);
      return { body, cached: false };
    } catch (error) {
      // A stale tile beats a broken map while the tile server is unreachable or refusing.
      if (cached !== null) {
        return { body: cached.body, cached: true };
      }
      throw error;
    }
  }

  async #fetchUpstream(z: number, x: number, y: number): Promise<Buffer> {
    await this.#acquire();
    try {
      const upstream = this.#options.upstream ?? TILE_UPSTREAM;
      const url = `${upstream}/${String(z)}/${String(x)}/${String(y)}.png`;
      const response = await (this.#options.fetchImpl ?? fetch)(url, {
        headers: { "user-agent": this.#options.userAgent, accept: "image/png" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        throw new TileError(502, `The tile server answered HTTP ${String(response.status)}.`);
      }
      if (!(response.headers.get("content-type") ?? "").startsWith("image/")) {
        throw new TileError(502, "The tile server did not send an image.");
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > MAX_TILE_BYTES) {
        throw new TileError(502, "The tile server sent an implausible tile.");
      }
      return body;
    } catch (error) {
      if (error instanceof TileError) {
        throw error;
      }
      throw new TileError(504, "The tile server could not be reached.");
    } finally {
      this.#release();
    }
  }

  /**
   * Deletes tiles older than the age limit, then the oldest until the cache fits its budget.
   * Returns how many were removed. Empty folders are left; they cost nothing.
   */
  async prune(): Promise<number> {
    const now = this.#options.now?.() ?? Date.now();
    const maxAge = this.#options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const budget = this.#options.maxCacheBytes ?? DEFAULT_CACHE_BYTES;
    const files = await listTiles(this.#options.cacheDir);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (now - file.mtimeMs <= maxAge && total <= budget) {
        break;
      }
      await rm(file.path, { force: true });
      total -= file.size;
      removed += 1;
    }
    return removed;
  }

  async #acquire(): Promise<void> {
    if (this.#active < MAX_UPSTREAM) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#active -= 1;
    } else {
      next();
    }
  }
}

async function listTiles(root: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return [];
  }
  const tiles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".png"))
      .map(async (entry) => {
        const file = path.join(root, entry);
        const info = await stat(file);
        return { path: file, size: info.size, mtimeMs: info.mtimeMs };
      }),
  );
  return tiles;
}

async function readCached(file: string): Promise<{ body: Buffer; mtimeMs: number } | null> {
  try {
    const info = await stat(file);
    return { body: await readFile(file), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}
