import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Services } from "../services.js";
import { registerAuth } from "./auth-plugin.js";
import { ApiError } from "./errors.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerParcelRoutes } from "./routes/parcels.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerTokenRoutes } from "./routes/tokens.js";

export type App = FastifyInstance;
export type TypedApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface BuildAppOptions {
  /** Set on the Home Assistant ingress listener only. */
  readonly trustedIngressAddress?: string;
}

function handleError(
  error: FastifyError,
  services: Services,
): { status: number; body: { error: string; message: string } } {
  if (error instanceof ApiError) {
    return { status: error.statusCode, body: { error: error.code, message: error.message } };
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const detail = error.validation
      .map((issue) => `${issue.instancePath || "/"} ${issue.message ?? ""}`.trim())
      .join("; ");
    return {
      status: 400,
      body: { error: "invalid_request", message: `The request is invalid: ${detail}.` },
    };
  }
  const status = error.statusCode ?? 500;
  if (status < 500) {
    return { status, body: { error: error.code.toLowerCase(), message: error.message } };
  }
  services.logger.error({ err: error }, "Request failed.");
  return {
    status: 500,
    body: { error: "internal", message: "Something went wrong on the server." },
  };
}

export async function buildApp(services: Services, options: BuildAppOptions = {}): Promise<App> {
  // Typed with the base logger interface so every hook and plug-in uses Fastify's default types.
  // Without the explicit arguments TypeScript infers pino's narrower Logger from `loggerInstance`,
  // which then fails to match every default-typed hook and plug-in.
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- explicit to stop inference from loggerInstance (see above)
    FastifyBaseLogger
  >({
    loggerInstance: services.logger,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const { status, body } = handleError(error, services);
    return reply.code(status).send(body);
  });

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "open-parcels",
        description: "Self-hosted parcel and order tracking.",
        version: "2.0.0",
      },
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer" },
          session: { type: "apiKey", in: "cookie", name: "op_session" },
        },
      },
      security: [{ bearer: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  registerAuth(app, { store: services.auth, trustedIngressAddress: options.trustedIngressAddress });

  const typed = app.withTypeProvider<ZodTypeProvider>();
  registerHealthRoutes(typed, services);
  registerSessionRoutes(typed, services);
  registerTokenRoutes(typed, services);
  registerParcelRoutes(typed, services);
  registerEventRoutes(typed, services);

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, () => app.swagger());
  await app.ready();
  return app;
}
