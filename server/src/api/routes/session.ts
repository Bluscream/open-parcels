import type { FastifyReply } from "fastify";
import { z } from "zod";
import { LoginThrottle } from "../../auth/throttle.js";
import { SCOPES } from "../../auth/store.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { SESSION_COOKIE } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const passwordSchema = z.string().min(10, "Use at least 10 characters.").max(256);

const sessionStateSchema = z.object({
  authenticated: z.boolean(),
  method: z.enum(["ingress", "token", "session"]).nullable(),
  scopes: z.array(z.enum(SCOPES)),
  csrf_token: z.string().nullable(),
  setup_required: z.boolean(),
});

async function startSession(
  services: Services,
  reply: FastifyReply,
  userAgent: string | undefined,
): Promise<string> {
  const session = await services.auth.createSession(userAgent ?? null);
  void reply.setCookie(SESSION_COOKIE, session.cookieValue, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: services.config.secureCookies,
    expires: new Date(session.expiresAt),
  });
  return session.csrfToken;
}

export function registerSessionRoutes(app: TypedApp, services: Services): void {
  const throttle = new LoginThrottle(services.clock);

  app.get(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary: "Who is calling, and whether first-start setup is pending.",
        security: [],
        response: { 200: sessionStateSchema },
      },
    },
    (request) => ({
      authenticated: request.auth !== null,
      method: request.auth?.kind ?? null,
      scopes: [...(request.auth?.scopes ?? [])],
      csrf_token: request.auth?.kind === "session" ? request.auth.csrfToken : null,
      setup_required: services.setup.pending,
    }),
  );

  app.post(
    "/api/v1/setup",
    {
      schema: {
        tags: ["session"],
        summary:
          "Set the owner password on first start. Needs the setup code from the container log.",
        security: [],
        body: z.object({ setup_code: z.string().max(64), password: passwordSchema }),
        response: {
          200: z.object({ csrf_token: z.string() }),
          403: errorBodySchema,
          409: errorBodySchema,
        },
      },
    },
    async (request, reply) => {
      if (!services.setup.pending) {
        throw new ApiError(409, "already_set_up", "The owner password is already set.");
      }
      // Home Assistant ingress has already authenticated the user, so it needs no setup code.
      if (request.auth?.kind !== "ingress" && !services.setup.matches(request.body.setup_code)) {
        throw new ApiError(
          403,
          "bad_setup_code",
          "The setup code does not match the one in the container log.",
        );
      }
      await services.auth.setOwnerPassword(request.body.password);
      services.setup.complete();
      services.logger.info("Owner password set; first-start setup is complete.");
      return { csrf_token: await startSession(services, reply, request.headers["user-agent"]) };
    },
  );

  app.post(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary: "Sign in with the owner password.",
        security: [],
        body: z.object({ password: z.string().max(256) }),
        response: {
          200: z.object({ csrf_token: z.string() }),
          401: errorBodySchema,
          429: errorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const key = request.ip;
      const wait = throttle.retryAfterSeconds(key);
      if (wait > 0) {
        void reply.header("retry-after", String(wait));
        throw new ApiError(
          429,
          "too_many_attempts",
          `Too many failed sign-ins. Try again in ${wait} seconds.`,
        );
      }
      if (!(await services.auth.verifyOwnerPassword(request.body.password))) {
        throttle.recordFailure(key);
        throw new ApiError(401, "wrong_password", "That password is not correct.");
      }
      throttle.reset(key);
      return { csrf_token: await startSession(services, reply, request.headers["user-agent"]) };
    },
  );

  app.delete(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary: "Sign out of this browser session.",
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const cookie = request.cookies[SESSION_COOKIE];
      if (cookie !== undefined) {
        await services.auth.deleteSession(cookie);
      }
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send(null);
    },
  );
}
