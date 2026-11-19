import { z } from "zod";
import type { Services } from "../../services.js";
import { TileError } from "../../tiles/proxy.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

const coordinate = z.coerce.number().int().min(0);

export function registerTileRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/tiles/:z/:x/:y.png",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "An OpenStreetMap tile, fetched and cached by this server.",
        params: z.object({ z: coordinate, x: coordinate, y: coordinate }),
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
