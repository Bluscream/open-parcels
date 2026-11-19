import { z } from "zod";
import { ImageProxyError } from "../../images/proxy.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

const PROXY_PATH = /^\/img\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32})$/;

export function registerImageRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/parcels/:id/picture",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["images"],
        summary: "The parcel's item pictures as one square PNG (1, 2×2 or 3×3 tiles).",
        description:
          "404 when none of its items has a picture. Used as the entity picture in Home Assistant.",
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const parcel = await services.parcels.repository.get(request.params.id);
      const pictures = (parcel?.items ?? [])
        .map((item) => item.image_url)
        .filter((url): url is string => url !== null);
      const png = await services.collages.make(pictures, async (picture) => {
        const match = PROXY_PATH.exec(picture);
        if (match?.[1] === undefined || match[2] === undefined) return null;
        try {
          return (await services.images.get(match[1], match[2])).body;
        } catch {
          return null;
        }
      });
      if (png === null) {
        return reply.code(404).send({ error: "not_found", message: "No item pictures." });
      }
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "private, max-age=3600")
        .header("x-content-type-options", "nosniff")
        .send(png);
    },
  );

  app.get(
    "/img/:file",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["images"],
        summary: "An item picture or delivery photo, served through this server.",
        description:
          "Addresses come from parcel data (`items[].image_url`); they are signed and cannot be made up.",
        params: z.object({ file: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32}$/) }),
      },
    },
    async (request, reply) => {
      const [token = "", signature = ""] = request.params.file.split(".");
      try {
        const image = await services.images.get(token, signature);
        return await reply
          .header("content-type", image.type)
          .header("cache-control", "private, max-age=86400, immutable")
          .header("x-content-type-options", "nosniff")
          .send(image.body);
      } catch (error) {
        if (error instanceof ImageProxyError) {
          return reply.code(error.statusCode).send({ error: "image", message: error.message });
        }
        throw error;
      }
    },
  );
}
