import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { Services } from "../../services.js";
import { TILE_MAX_ZOOM, TILE_MAX_ZOOM_ANY, TileError } from "../../tiles/proxy.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

/** At the deepest zoom a column or row is below 2^zoom; anything larger is refused up front. */
const coordinate = (maxZoom: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** maxZoom - 1);

const layerSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["base", "overlay"]),
  max_zoom: z.number().int(),
  attribution: z.string().describe("HTML for the map's attribution control."),
  satellite: z.boolean().describe("Photographic imagery: no dark-mode filter."),
});

const layersSchema = z.object({
  layers: z.array(layerSchema),
  default_base: z.string().describe("Base layer shown until the user picks one."),
  default_overlay: z.string().nullable(),
});

async function sendTile(
  services: Services,
  reply: FastifyReply,
  layer: string,
  zoom: number,
  x: number,
  y: number,
): Promise<FastifyReply> {
  try {
    const tile = await services.tiles.get(layer, zoom, x, y);
    return await reply
      .header("content-type", tile.contentType)
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .send(tile.body);
  } catch (error) {
    if (error instanceof TileError) {
      return reply.code(error.statusCode).send({ error: "tile", message: error.message });
    }
    throw error;
  }
}

export function registerTileRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/map/layers",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "The map styles this server proxies, without their upstream addresses or keys.",
        response: { 200: layersSchema },
      },
    },
    () => {
      const layers = services.tiles.layers();
      const { baseLayer, overlay } = services.config.map;
      const hasBase = layers.some((layer) => layer.id === baseLayer);
      return {
        layers: layers.map((layer) => ({
          id: layer.id,
          label: layer.label,
          kind: layer.kind,
          max_zoom: layer.maxZoom,
          attribution: layer.attribution,
          satellite: layer.satellite,
        })),
        // A custom default without a usable custom provider falls back to the plain map.
        default_base: hasBase ? baseLayer : "osm",
        default_overlay: overlay === "none" ? null : overlay,
      };
    },
  );

  app.get(
    "/tiles/:layer/:z/:x/:y",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "A map tile of one of the listed layers, fetched and cached by this server.",
        params: z.object({
          layer: z.string().regex(/^[a-z0-9-]{1,32}$/),
          z: z.coerce.number().int().min(0).max(TILE_MAX_ZOOM_ANY),
          x: coordinate(TILE_MAX_ZOOM_ANY),
          y: coordinate(TILE_MAX_ZOOM_ANY),
        }),
      },
    },
    async (request, reply) => {
      const { layer, z: zoom, x, y } = request.params;
      return sendTile(services, reply, layer, zoom, x, y);
    },
  );

  app.get(
    "/tiles/:z/:x/:y.png",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["map"],
        summary: "An OpenStreetMap tile (older clients; same as layer osm).",
        params: z.object({
          z: z.coerce.number().int().min(0).max(TILE_MAX_ZOOM),
          x: coordinate(TILE_MAX_ZOOM),
          y: coordinate(TILE_MAX_ZOOM),
        }),
      },
    },
    async (request, reply) => {
      const { z: zoom, x, y } = request.params;
      return sendTile(services, reply, "osm", zoom, x, y);
    },
  );
}
