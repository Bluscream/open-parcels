import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Width and height of a parcel picture, in pixels. */
export const COLLAGE_SIZE = 256;
const MAX_TILES = 9;

/** Square tiles: one picture alone, 2 to 4 in a 2×2 grid, 5 and more in 3×3. */
export function gridFor(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

/** The "+N" tile when more pictures exist than fit. */
function moreTile(size: number, more: number): Buffer {
  const font = Math.round(size * 0.36);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}">` +
      `<rect width="100%" height="100%" fill="#1e293b"/>` +
      `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" ` +
      `font-family="sans-serif" font-weight="700" font-size="${String(font)}" fill="#f8fafc">` +
      `+${String(more)}</text></svg>`,
  );
}

/**
 * One PNG from a parcel's item pictures, as square tiles. Built pictures are kept on disk by
 * their sources, so the same items never cost the work twice. `load` returns a picture's bytes,
 * or null when it cannot be had (it is then left out).
 */
export class CollageMaker {
  constructor(private readonly cacheDir: string) {}

  async make(
    pictures: readonly string[],
    load: (picture: string) => Promise<Buffer | null>,
  ): Promise<Buffer | null> {
    if (pictures.length === 0) return null;
    const key = createHash("sha256").update(pictures.join("\n")).digest("hex").slice(0, 32);
    const file = path.join(this.cacheDir, `${key}.png`);
    const cached = await readFile(file).catch(() => null);
    if (cached !== null) return cached;

    const loaded = (await Promise.all(pictures.slice(0, MAX_TILES).map(load))).filter(
      (bytes): bytes is Buffer => bytes !== null,
    );
    if (loaded.length === 0) return null;
    const overflow = pictures.length - MAX_TILES;
    const columns = gridFor(Math.min(pictures.length, MAX_TILES));
    const tile = Math.floor(COLLAGE_SIZE / columns);
    // With more pictures than tiles, the last tile counts the rest.
    const shown = overflow > 0 ? loaded.slice(0, MAX_TILES - 1) : loaded;
    const tiles = await Promise.all(
      shown.map((bytes) =>
        sharp(bytes)
          .resize(tile, tile, { fit: "cover" })
          .png()
          .toBuffer()
          .catch(() => null),
      ),
    );
    const layers: { input: Buffer; left: number; top: number }[] = tiles
      .flatMap((bytes) => (bytes === null ? [] : [bytes]))
      .map((input, index) => ({
        input,
        left: (index % columns) * tile,
        top: Math.floor(index / columns) * tile,
      }));
    if (overflow > 0) {
      const index = MAX_TILES - 1;
      layers.push({
        input: await sharp(moreTile(tile, overflow + 1))
          .png()
          .toBuffer(),
        left: (index % columns) * tile,
        top: Math.floor(index / columns) * tile,
      });
    }
    if (layers.length === 0) return null;
    const png = await sharp({
      create: {
        width: tile * columns,
        height: tile * columns,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(layers)
      .png()
      .toBuffer();
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(file, png);
    return png;
  }
}
