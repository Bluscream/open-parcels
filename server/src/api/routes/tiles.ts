import { z } from "zod";
import type { Services } from "../../services.js";
import { TILE_MAX_ZOOM, TileError } from "../../tiles/proxy.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

/** At the deepest zoom a column or row is below 2^19; anything larger is refused up front. */
const coordinate = z.coerce
  .number()
  .int()
  .min(0)
  .max(2 ** TILE_MAX_ZOOM - 1);

export function registerTileRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/tiles/:z/:x/:y.png",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "An OpenStreetMap tile, fetched and cached by this server.",
        params: z.object({
          z: z.coerce.number().int().min(0).max(TILE_MAX_ZOOM),
          x: coordinate,
          y: coordinate,
        }),
      },
    },
    async (request, reply) => {
      const { z: zoom, x, y } = request.params;
      try {
        const tile = await services.tiles.get(zoom, x, y);
        return await reply
          .header("content-type", "image/png")
          .header("cache-control", "private, max-age=86400")
          .header("x-content-type-options", "nosniff")
          .send(tile.body);
      } catch (error) {
        if (error instanceof TileError) {
          return reply.code(error.statusCode).send({ error: "tile", message: error.message });
        }
        throw error;
      }
    },
  );
}
