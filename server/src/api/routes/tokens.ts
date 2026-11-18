import { z } from "zod";
import { SCOPES } from "../../auth/store.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { errorBodySchema, notFound } from "../errors.js";

const tokenInfoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.enum(SCOPES)),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});

export function registerTokenRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");

  app.get(
    "/api/v1/tokens",
    {
      preHandler: admin,
      schema: {
        tags: ["tokens"],
        summary: "List API tokens (values are never shown again).",
        response: { 200: z.array(tokenInfoSchema) },
      },
    },
    async () =>
      (await services.auth.listTokens()).map((token) => ({
        id: token.id,
        name: token.name,
        scopes: [...token.scopes],
        created_at: token.createdAt,
        last_used_at: token.lastUsedAt,
        expires_at: token.expiresAt,
      })),
  );

  app.post(
    "/api/v1/tokens",
    {
      preHandler: admin,
      schema: {
        tags: ["tokens"],
        summary: "Create an API token. The value is returned once.",
        body: z.object({
          name: z.string().min(1).max(80),
          scopes: z.array(z.enum(SCOPES)).min(1),
          expires_at: z.iso.datetime({ offset: true }).nullable().default(null),
        }),
        response: { 201: z.object({ token: z.string(), info: tokenInfoSchema }) },
      },
    },
    async (request, reply) => {
      const { token, info } = await services.auth.createToken(
        request.body.name,
        request.body.scopes,
        request.body.expires_at,
      );
      return reply.code(201).send({
        token,
        info: {
          id: info.id,
          name: info.name,
          scopes: [...info.scopes],
          created_at: info.createdAt,
          last_used_at: info.lastUsedAt,
          expires_at: info.expiresAt,
        },
      });
    },
  );

  app.delete(
    "/api/v1/tokens/:id",
    {
      preHandler: admin,
      schema: {
        tags: ["tokens"],
        summary: "Revoke an API token.",
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.auth.deleteToken(request.params.id))) {
        throw notFound("The token");
      }
      return reply.code(204).send(null);
    },
  );
}
