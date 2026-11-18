import { sql } from "kysely";
import { z } from "zod";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";

const healthSchema = z.object({ status: z.enum(["ok", "unavailable"]) });

export function registerHealthRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/health/live",
    {
      schema: {
        tags: ["health"],
        summary: "The process is running.",
        security: [],
        response: { 200: healthSchema },
      },
    },
    () => ({ status: "ok" as const }),
  );

  app.get(
    "/api/v1/health/ready",
    {
      schema: {
        tags: ["health"],
        summary: "The service can answer requests: the database responds.",
        security: [],
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (_request, reply) => {
      try {
        await sql`select 1`.execute(services.db);
        return { status: "ok" as const };
      } catch (error) {
        services.logger.error({ err: error }, "Readiness check failed.");
        return reply.code(503).send({ status: "unavailable" as const });
      }
    },
  );
}
