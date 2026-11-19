import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LoginThrottle } from "../../auth/throttle.js";
import { ROLES, SCOPES, type Role } from "../../auth/store.js";
import { MIN_ADMIN_PASSWORD } from "../../config.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope, SESSION_COOKIE } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const passwordSchema = z
  .string()
  .min(MIN_ADMIN_PASSWORD, `Use at least ${MIN_ADMIN_PASSWORD} characters.`)
  .max(256);

const sessionStateSchema = z.object({
  authenticated: z.boolean().describe("Signed in, or a token or Home Assistant ingress."),
  method: z.enum(["ingress", "token", "session", "anonymous"]).nullable(),
  role: z
    .enum(ROLES)
    .nullable()
    .describe("What the caller may do; reader when reading is open. Null: must sign in first."),
  scopes: z.array(z.enum(SCOPES)),
  csrf_token: z.string().nullable(),
  reader_required: z.boolean().describe("OPENPARCELS_PASSWORD is set: reading needs a sign-in."),
  setup_required: z.boolean(),
});

const signedInSchema = z.object({ csrf_token: z.string(), role: z.enum(ROLES) });

async function startSession(
  services: Services,
  reply: FastifyReply,
  userAgent: string | undefined,
  role: Role,
): Promise<z.infer<typeof signedInSchema>> {
  const session = await services.auth.createSession(userAgent ?? null, role);
  void reply.setCookie(SESSION_COOKIE, session.cookieValue, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: services.config.secureCookies,
    expires: new Date(session.expiresAt),
  });
  return { csrf_token: session.csrfToken, role };
}

/** Throws 429 while the caller's address has too many recent failures. */
function checkThrottle(
  throttle: LoginThrottle,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const wait = throttle.retryAfterSeconds(request.ip);
  if (wait > 0) {
    void reply.header("retry-after", String(wait));
    throw new ApiError(
      429,
      "too_many_attempts",
      `Too many failed attempts. Try again in ${wait} seconds.`,
    );
  }
}

function registerAdminPasswordRoutes(app: TypedApp, services: Services): void {
  app.put(
    "/api/v1/admin-password",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["session"],
        summary:
          "Change the admin password. Saved hashed, it wins over OPENPARCELS_ADMIN_PASSWORD until reset. Signs every session out.",
        body: z.object({
          current: z
            .string()
            .max(256)
            .nullable()
            .describe("The current admin password; may be null only through Home Assistant."),
          next: passwordSchema,
        }),
        response: { 204: z.null(), 400: errorBodySchema },
      },
    },
    async (request, reply) => {
      const { current, next } = request.body;
      if (current === null && request.auth?.kind !== "ingress") {
        throw new ApiError(400, "current_required", "Enter the current admin password.");
      }
      const result = await services.access.changeAdminPassword(current, next);
      if (!result.ok) throw new ApiError(400, "invalid_password", result.error);
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/api/v1/admin-password",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["session"],
        summary:
          "Forget the admin password changed in the UI, so OPENPARCELS_ADMIN_PASSWORD applies again. Signs every session out.",
        response: { 204: z.null(), 409: errorBodySchema },
      },
    },
    async (_request, reply) => {
      const result = await services.access.resetAdminPassword();
      if (!result.ok) throw new ApiError(409, "no_environment_password", result.error);
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send(null);
    },
  );
}

export function registerSessionRoutes(app: TypedApp, services: Services): void {
  const throttle = new LoginThrottle(services.clock);

  app.get(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary: "Who is calling, what they may do, and whether first-start setup is pending.",
        security: [],
        response: { 200: sessionStateSchema },
      },
    },
    (request) => {
      const auth = request.auth;
      return {
        authenticated: auth !== null && auth.kind !== "anonymous",
        method: auth?.kind ?? null,
        role: auth?.role ?? null,
        scopes: [...(auth?.scopes ?? [])],
        csrf_token: auth?.kind === "session" ? auth.csrfToken : null,
        reader_required: services.access.readerRequired,
        setup_required: services.access.setupPending,
      };
    },
  );

  app.post(
    "/api/v1/setup",
    {
      schema: {
        tags: ["session"],
        summary:
          "Set the admin password on first start. Needs the setup code from the container log.",
        security: [],
        body: z.object({ setup_code: z.string().max(64), password: passwordSchema }),
        response: {
          200: signedInSchema,
          403: errorBodySchema,
          409: errorBodySchema,
          429: errorBodySchema,
        },
      },
    },
    async (request, reply) => {
      if (!services.access.setupPending) {
        throw new ApiError(409, "already_set_up", "The admin password is already set.");
      }
      checkThrottle(throttle, request, reply);
      // Home Assistant ingress has already authenticated the user, so it needs no setup code.
      if (
        request.auth?.kind !== "ingress" &&
        !services.access.setupCodeMatches(request.body.setup_code)
      ) {
        throttle.recordFailure(request.ip);
        throw new ApiError(
          403,
          "bad_setup_code",
          "The setup code does not match the one in the container log.",
        );
      }
      await services.access.completeSetup(request.body.password);
      services.logger.info("Admin password set; first-start setup is complete.");
      return startSession(services, reply, request.headers["user-agent"], "admin");
    },
  );

  app.post(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary:
          "Sign in with the admin password (may change anything) or OPENPARCELS_PASSWORD (may read).",
        security: [],
        body: z.object({ password: z.string().max(256) }),
        response: {
          200: signedInSchema,
          401: errorBodySchema,
          429: errorBodySchema,
        },
      },
    },
    async (request, reply) => {
      checkThrottle(throttle, request, reply);
      const role = await services.access.roleFor(request.body.password);
      if (role === null) {
        throttle.recordFailure(request.ip);
        services.logger.info({ ip: request.ip }, "A sign-in failed.");
        throw new ApiError(401, "wrong_password", "That password is not correct.");
      }
      throttle.reset(request.ip);
      return startSession(services, reply, request.headers["user-agent"], role);
    },
  );

  app.delete(
    "/api/v1/session",
    {
      schema: {
        tags: ["session"],
        summary: "Sign out of this browser session.",
        // Anyone may sign out, readers included; it only ends the caller's own session.
        security: [],
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

  registerAdminPasswordRoutes(app, services);
}
