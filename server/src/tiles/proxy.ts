import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_LAYERS, tileUrl, type TileLayerDef } from "./layers.js";

/**
 * Map tiles fetched through this server, following OpenStreetMap's tile usage policy (applied to
 * every provider): an identifying User-Agent, at most two upstream connections, and a disk cache
 * honoured for a week. Browsers that strip the Referer (LibreWolf, privacy add-ons) are refused by
 * the tile servers when they ask directly, and the providers never see the user's browser, so the
 * web UI always goes through here. Each layer has its own cache folder.
 */
export const TILE_MAX_ZOOM = 19;
/** No provider serves deeper than this; the route refuses anything beyond it up front. */
export const TILE_MAX_ZOOM_ANY = 22;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPSTREAM = 2;
const MAX_TILE_BYTES = 1024 * 1024;
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
  readonly contentType: string;
}

export interface TileProxyOptions {
  readonly cacheDir: string;
  readonly userAgent: string;
  /** The layers that may be fetched, read on every request so setting changes apply at once. */
  readonly layers?: () => readonly TileLayerDef[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Tiles not refreshed for this long are deleted by `prune()`. */
  readonly maxAgeMs?: number;
  readonly maxCacheBytes?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_BYTES = 200 * 1024 * 1024;
const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg" } as const;

/** Valid slippy-map coordinates only; anything else never reaches the network or the disk. */
export function validTile(z: number, x: number, y: number, maxZoom = TILE_MAX_ZOOM): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > maxZoom) {
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

  /** The allowlist: the built-in layers plus a configured custom provider. */
  layers(): readonly TileLayerDef[] {
    return this.#options.layers?.() ?? BUILTIN_LAYERS;
  }

  /** Unknown layers are refused before anything is fetched or read. */
  async get(layerId: string, z: number, x: number, y: number): Promise<Tile> {
    const layer = this.layers().find((candidate) => candidate.id === layerId);
    if (layer === undefined) {
      throw new TileError(404, "There is no such map layer.");
    }
    if (!validTile(z, x, y, layer.maxZoom)) {
      throw new TileError(400, "Not a map tile.");
    }
    const key = `${layer.cacheKey}/${String(z)}/${String(x)}/${String(y)}`;
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const work = this.#load(layer, z, x, y).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, work);
    return work;
  }

  async #load(layer: TileLayerDef, z: number, x: number, y: number): Promise<Tile> {
    const contentType = CONTENT_TYPES[layer.format];
    const file = path.join(
      this.#options.cacheDir,
      layer.cacheKey,
      String(z),
      String(x),
      `${String(y)}.${layer.format}`,
    );
    const now = this.#options.now?.() ?? Date.now();
    const cached = await readCached(file);
    if (cached !== null && now - cached.mtimeMs < FRESH_MS) {
      return { body: cached.body, cached: true, contentType };
    }
    try {
      const body = await this.#fetchUpstream(layer, z, x, y);
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${String(process.pid)}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, file);
      return { body, cached: false, contentType };
    } catch (error) {
      // A stale tile beats a broken map while the tile server is unreachable or refusing.
      if (cached !== null) {
        return { body: cached.body, cached: true, contentType };
      }
      throw error;
    }
  }

  async #fetchUpstream(layer: TileLayerDef, z: number, x: number, y: number): Promise<Buffer> {
    await this.#acquire();
    try {
      const response = await (this.#options.fetchImpl ?? fetch)(tileUrl(layer, z, x, y), {
        headers: { "user-agent": this.#options.userAgent, accept: "image/*" },
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
      .filter((entry) => entry.endsWith(".png") || entry.endsWith(".jpg"))
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
