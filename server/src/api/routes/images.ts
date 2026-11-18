import { z } from "zod";
import { ImageProxyError } from "../../images/proxy.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

export function registerImageRoutes(app: TypedApp, services: Services): void {
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
