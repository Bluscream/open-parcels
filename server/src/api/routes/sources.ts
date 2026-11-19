import { z } from "zod";
import { InvalidSourceConfigError } from "../../engine/registry.js";
import type { SourceView } from "../../engine/sources.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

/** "45 seconds", "12 minutes", "3 hours": rounded up, for a message a person reads. */
export function waitText(seconds: number): string {
  if (seconds < 90) {
    return `${String(seconds)} seconds`;
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)} minutes`;
  }
  return `${String(Math.ceil(minutes / 60))} hours`;
}

const sourceSchema = z.object({
  id: z.uuid(),
  plugin: z.string(),
  kind: z.enum(["account", "tracking", "shop", "mail"]),
  label: z.string(),
  config: z.unknown(),
  has_secret: z
    .boolean()
    .describe("Whether sign-in data is stored. The data itself is never returned."),
  state: z.enum(["ok", "needs_sign_in", "error", "disabled"]),
  state_detail: z.string().nullable(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_ok_at: z.string().nullable(),
});

const carrierSchema = z.object({
  id: z.string(),
  name: z.string(),
  countries: z.array(z.string()),
  source_kinds: z.array(z.enum(["account", "tracking", "shop"])),
  sign_in: z
    .string()
    .describe("Type of the default sign-in flow: none, credentials, api_key or interactive."),
  sign_in_flows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        type: z.enum(["none", "credentials", "api_key", "interactive"]),
        kinds: z.array(z.enum(["account", "tracking", "shop"])),
        conditional: z
          .boolean()
          .describe("Applies only to some configurations; ask the source's own flow list."),
      }),
    )
    .describe("Every sign-in flow of the plug-in. Interactive ones run as sign-in attempts."),
  config_schema: z.unknown().describe("JSON Schema of the source configuration form."),
  secret_schema: z
    .unknown()
    .describe(
      "JSON Schema of the sign-in data for credentials and api_key flows: field names only, never values.",
    ),
  browser_user_agent_reason: z.string().nullable(),
});

function toBody(view: SourceView): z.infer<typeof sourceSchema> {
  return {
    id: view.id,
    plugin: view.plugin,
    kind: view.kind,
    label: view.label,
    config: view.config,
    has_secret: view.hasSecret,
    state: view.state,
    state_detail: view.stateDetail,
    next_run_at: view.nextRunAt,
    last_run_at: view.lastRunAt,
    last_ok_at: view.lastOkAt,
  };
}

function asBadRequest(error: unknown): never {
  if (error instanceof InvalidSourceConfigError) {
    throw new ApiError(400, "invalid_source", error.message);
  }
  throw error;
}

export function registerSourceRoutes(app: TypedApp, services: Services): void {
  const read = requireScope("read");
  const admin = requireScope("admin");

  app.get(
    "/api/v1/carriers",
    {
      preHandler: read,
      schema: {
        tags: ["sources"],
        summary: "Installed carrier plug-ins and how to set them up.",
        response: { 200: z.array(carrierSchema) },
      },
    },
    () =>
      services.registry.list().map((plugin) => ({
        id: plugin.info.id,
        name: plugin.info.name,
        countries: [...plugin.info.countries],
        source_kinds: [...plugin.info.sourceKinds],
        sign_in: plugin.info.signIn,
        sign_in_flows: plugin.info.signInFlows.map((flow) => ({ ...flow, kinds: [...flow.kinds] })),
        config_schema: z.toJSONSchema(plugin.info.configSchema, { unrepresentable: "any" }),
        secret_schema: z.toJSONSchema(plugin.info.secretSchema, { unrepresentable: "any" }),
        browser_user_agent_reason: plugin.info.browserUserAgentReason,
      })),
  );

  app.get(
    "/api/v1/sources",
    {
      preHandler: read,
      schema: {
        tags: ["sources"],
        summary: "Carrier accounts, shops, tracking sources and mailboxes.",
        response: { 200: z.array(sourceSchema) },
      },
    },
    async () => (await services.sources.list()).map(toBody),
  );

  app.post(
    "/api/v1/sources",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Add a source. Sign-in data is encrypted at rest and never returned.",
        body: z.object({
          plugin: z.string().min(1).max(64),
          kind: z
            .enum(["account", "tracking", "shop", "mail"])
            .describe(
              'Mailboxes use the plug-in "imap" with config {host, port, secure, folders}.',
            ),
          label: z.string().min(1).max(80),
          config: z.unknown().default({}),
          secret: z.unknown().default(null),
        }),
        response: { 201: sourceSchema, 400: errorBodySchema },
      },
    },
    async (request, reply) => {
      const created = await services.sources.create(request.body).catch(asBadRequest);
      if (created.kind === "mail") {
        await services.mail.connect(created.id);
      }
      services.scheduler.wake();
      return reply.code(201).send(toBody(created));
    },
  );

  app.patch(
    "/api/v1/sources/:id",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Rename, reconfigure, enable or disable a source.",
        params: idParams,
        body: z.object({
          label: z.string().min(1).max(80).optional(),
          config: z.unknown().optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: sourceSchema, 400: errorBodySchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const body = request.body;
      const updated = await services.sources
        .updateSettings(request.params.id, {
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.config === undefined ? {} : { config: body.config }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        })
        .catch(asBadRequest);
      if (updated?.kind === "mail") {
        await (updated.state === "disabled"
          ? services.mail.disconnect(updated.id)
          : services.mail.connect(updated.id));
      }
      if (updated === undefined) {
        throw notFound("The source");
      }
      if (body.enabled === true) {
        // Enabling makes the source due at once; without a wake the run waited for the next
        // timer, up to minutes, while the card claimed it was due "just now".
        services.scheduler.wake();
      }
      return toBody(updated);
    },
  );

  app.put(
    "/api/v1/sources/:id/secret",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Replace the sign-in data (credentials or API key) and run the source.",
        params: idParams,
        body: z.object({ secret: z.unknown() }),
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if ((await services.sources.get(request.params.id)) === undefined) {
        throw notFound("The source");
      }
      await services.sources.setSecret(request.params.id, request.body.secret);
      if ((await services.sources.get(request.params.id))?.kind === "mail") {
        await services.mail.connect(request.params.id);
      }
      services.scheduler.wake();
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/api/v1/sources/:id/sync",
    {
      preHandler: requireScope("write"),
      schema: {
        tags: ["sources"],
        summary: "Run a source now.",
        description:
          "While the source backs off (a captcha pause or the carrier's rate limit) the run is " +
          "not brought forward: the answer is 429 `source_backing_off` with `Retry-After`.",
        params: idParams,
        response: { 202: z.null(), 404: errorBodySchema, 429: errorBodySchema },
      },
    },
    async (request, reply) => {
      if ((await services.sources.get(request.params.id)) === undefined) {
        throw notFound("The source");
      }
      const { deferredUntil } = await services.sources.requestRun(request.params.id);
      if (deferredUntil !== null) {
        const seconds = Math.max(
          1,
          Math.ceil((Date.parse(deferredUntil) - services.clock.now().getTime()) / 1000),
        );
        void reply.header("retry-after", String(seconds));
        throw new ApiError(
          429,
          "source_backing_off",
          `The carrier asked us to wait; this source runs again in ${waitText(seconds)}.`,
        );
      }
      services.scheduler.wake();
      return reply.code(202).send(null);
    },
  );

  app.delete(
    "/api/v1/sources/:id",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Remove a source and its stored sign-in.",
        params: idParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      await services.mail.disconnect(request.params.id);
      if (!(await services.sources.delete(request.params.id))) {
        throw notFound("The source");
      }
      return reply.code(204).send(null);
    },
  );
}
