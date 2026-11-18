import { z } from "zod";
import { InvalidSourceConfigError } from "../../engine/registry.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });
const ATTEMPT_TTL_MS = 10 * 60_000;

/**
 * Pasted-link sign-in: the user signs in on the carrier's own page in their browser (where
 * passwords, two-factor codes and captchas are handled by the carrier) and pastes the address
 * they end up on. The state between both steps stays in memory for ten minutes.
 */
export function registerSignInRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");
  const pending = new Map<string, { state: unknown; expires: number }>();

  async function sourceAndPlugin(id: string) {
    const source = await services.sources.get(id);
    const plugin = source === undefined ? undefined : services.registry.get(source.plugin);
    if (source === undefined || plugin === undefined) {
      throw notFound("The source");
    }
    return { source, plugin };
  }

  app.post(
    "/api/v1/sources/:id/sign-in/start",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Start a pasted-link sign-in: returns the address to open in your browser.",
        params: idParams,
        response: {
          200: z.object({ url: z.string() }),
          400: errorBodySchema,
          404: errorBodySchema,
        },
      },
    },
    async (request) => {
      const { source, plugin } = await sourceAndPlugin(request.params.id);
      try {
        const { url, state } = await plugin.startSignIn(source.config, services.clock);
        pending.set(source.id, { state, expires: services.clock.now().getTime() + ATTEMPT_TTL_MS });
        return { url };
      } catch (error) {
        if (error instanceof InvalidSourceConfigError) {
          throw new ApiError(400, "invalid_source", error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/sources/:id/sign-in/finish",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Finish a pasted-link sign-in with the address the browser ended on.",
        params: idParams,
        body: z.object({ pasted: z.string().min(1).max(8192) }),
        response: { 204: z.null(), 400: errorBodySchema, 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      const { source, plugin } = await sourceAndPlugin(request.params.id);
      const started = pending.get(source.id);
      if (started === undefined || started.expires < services.clock.now().getTime()) {
        throw new ApiError(
          400,
          "sign_in_expired",
          "Start the sign-in again; the previous attempt expired.",
        );
      }
      let secret: unknown;
      try {
        secret = await plugin.finishSignIn(
          services.runner.httpFor(plugin.http),
          services.clock,
          started.state,
          request.body.pasted,
        );
      } catch (error) {
        // The pasted address may hold one-time codes; only the error type is logged.
        services.logger.warn(
          { plugin: plugin.info.id, error: error instanceof Error ? error.name : "unknown" },
          "Pasted sign-in failed.",
        );
        throw new ApiError(
          400,
          "sign_in_failed",
          "The sign-in did not work. Start again and paste the full address from the browser's address bar.",
        );
      }
      pending.delete(source.id);
      await services.sources.setSecret(source.id, secret);
      services.scheduler.wake();
      return reply.code(204).send(null);
    },
  );
}
