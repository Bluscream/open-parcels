import type { FastifyReply } from "fastify";
import { z } from "zod";
import { SignInError, type AttemptView, type SignInErrorCode } from "../../engine/sign-in.js";
import type { SignInStep } from "../../plugin/api.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const idParams = z.object({ id: z.uuid() });
const attemptParams = z.object({ id: z.uuid(), attempt: z.uuid() });

const message = z.string().optional();
const stepSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("form"),
      fields: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.enum(["text", "email", "password", "tel"]),
        }),
      ),
      message,
    }),
    z.object({ kind: z.literal("open_url"), url: z.string(), message }),
    z.object({ kind: z.literal("email_link"), destination: z.string().nullable(), message }),
    z.object({
      kind: z.literal("otp_code"),
      channel: z.enum(["sms", "email", "app", "other"]),
      destination: z.string().nullable(),
      message,
    }),
    z.object({
      kind: z.literal("choose_method"),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      message,
    }),
    z.object({
      kind: z.literal("await_approval"),
      message: z.string(),
      poll_interval_seconds: z.number(),
      timeout_seconds: z.number(),
    }),
  ])
  .describe(
    "What to show next. Input keys: form → one per field; open_url → pasted; " +
      "email_link and otp_code → code; choose_method → choice; await_approval → none, poll instead.",
  );

const attemptSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("step"),
    attempt_id: z.uuid(),
    flow: z.string(),
    expires_at: z.string(),
    step: stepSchema,
  }),
  z.object({ status: z.literal("done") }),
]);

const flowSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["none", "credentials", "api_key", "interactive"]),
  kinds: z.array(z.enum(["account", "tracking", "shop"])),
  conditional: z.boolean(),
  secret_schema: z
    .unknown()
    .nullable()
    .describe("JSON Schema of what to fill in for this flow; null: the carrier's secret_schema."),
});

const STATUS: Readonly<Record<SignInErrorCode, number>> = {
  sign_in_expired: 400,
  sign_in_timeout: 400,
  sign_in_refused: 400,
  sign_in_failed: 400,
  sign_in_wrong_step: 409,
  sign_in_poll_too_soon: 429,
  sign_in_unavailable: 503,
  sign_in_captcha: 503,
  no_sign_in: 400,
  invalid_source: 400,
  not_found: 404,
};

const errors = {
  400: errorBodySchema,
  404: errorBodySchema,
  409: errorBodySchema,
  429: errorBodySchema,
  503: errorBodySchema,
};

function toBody(view: AttemptView): z.infer<typeof attemptSchema> {
  if (view.status === "done") {
    return { status: "done" };
  }
  return {
    status: "step",
    attempt_id: view.attemptId,
    flow: view.flow,
    expires_at: view.expiresAt,
    step: stepBody(view.step),
  };
}

function stepBody(step: SignInStep): z.infer<typeof stepSchema> {
  switch (step.kind) {
    case "form":
      return { ...step, fields: step.fields.map((field) => ({ ...field })) };
    case "choose_method":
      return { ...step, options: step.options.map((option) => ({ ...option })) };
    case "await_approval":
      return {
        kind: "await_approval",
        message: step.message,
        poll_interval_seconds: step.pollIntervalSeconds,
        timeout_seconds: step.timeoutSeconds,
      };
    case "open_url":
    case "email_link":
    case "otp_code":
      return { ...step };
  }
}

/** Turns a sign-in failure into the API error (with Retry-After when known). */
function failWith(reply: FastifyReply | null) {
  return (error: unknown): never => {
    if (error instanceof SignInError) {
      if (reply !== null && error.retryAfterSeconds !== undefined) {
        void reply.header("retry-after", String(error.retryAfterSeconds));
      }
      throw new ApiError(STATUS[error.code], error.code, error.message);
    }
    throw error;
  };
}

/**
 * Sign-in. Interactive flows run as attempts: start one, answer each step, poll while it waits for
 * an approval on another device. The plug-in's state stays encrypted on the server. The old
 * `start`/`finish` pair still drives a pasted-link flow in one call each.
 */
export function registerSignInRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");
  const { signIn } = services;

  app.get(
    "/api/v1/sources/:id/sign-in/flows",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "The ways this source can sign in, the default first.",
        params: idParams,
        response: { 200: z.array(flowSchema), 404: errorBodySchema },
      },
    },
    async (request) => {
      const flows = await signIn.flows(request.params.id).catch(failWith(null));
      return flows.map(({ fields, ...flow }) => ({
        ...flow,
        kinds: [...flow.kinds],
        secret_schema: fields === null ? null : z.toJSONSchema(fields, { unrepresentable: "any" }),
      }));
    },
  );

  app.post(
    "/api/v1/sources/:id/sign-in/attempts",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Start an interactive sign-in. Replaces an unfinished one for the same source.",
        params: idParams,
        body: z.object({ flow: z.string().max(64).optional() }).default({}),
        response: { 200: attemptSchema, ...errors },
      },
    },
    async (request, reply) =>
      toBody(await signIn.start(request.params.id, request.body.flow).catch(failWith(reply))),
  );

  app.post(
    "/api/v1/sources/:id/sign-in/attempts/:attempt/continue",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Answer the current step. A refused code keeps the step for another try.",
        params: attemptParams,
        body: z.object({ input: z.record(z.string().max(64), z.string().max(8192)) }),
        response: { 200: attemptSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { id, attempt } = request.params;
      const view = await signIn.continue(id, attempt, request.body.input).catch(failWith(reply));
      if (view.status === "done") {
        services.scheduler.wake();
      }
      return toBody(view);
    },
  );

  app.post(
    "/api/v1/sources/:id/sign-in/attempts/:attempt/poll",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary:
          "Check an approval step. Refused (429) when called faster than the step's interval; " +
          "fails with sign_in_timeout after its timeout.",
        params: attemptParams,
        response: { 200: attemptSchema, ...errors },
      },
    },
    async (request, reply) => {
      const { id, attempt } = request.params;
      const view = await signIn.poll(id, attempt).catch(failWith(reply));
      if (view.status === "done") {
        services.scheduler.wake();
      }
      return toBody(view);
    },
  );

  app.delete(
    "/api/v1/sources/:id/sign-in/attempts/:attempt",
    {
      preHandler: admin,
      schema: {
        tags: ["sources"],
        summary: "Cancel an unfinished sign-in.",
        params: attemptParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await signIn.cancel(request.params.id, request.params.attempt))) {
        throw new ApiError(404, "not_found", "The sign-in attempt was not found.");
      }
      return reply.code(204).send(null);
    },
  );

  registerPastedRoutes(app, services);
}

/** The original two pasted-link routes, kept for existing clients. */
function registerPastedRoutes(app: TypedApp, services: Services): void {
  const admin = requireScope("admin");
  const { signIn } = services;

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
          503: errorBodySchema,
        },
      },
    },
    async (request) => {
      const view = await signIn.start(request.params.id).catch(failWith(null));
      if (view.status === "step" && view.step.kind === "open_url") {
        return { url: view.step.url };
      }
      if (view.status === "step") {
        await signIn.cancel(request.params.id, view.attemptId);
      }
      throw new ApiError(
        400,
        "invalid_source",
        "This source does not sign in with a pasted link; use the sign-in attempts.",
      );
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
      const attempt = await signIn.current(request.params.id);
      const view =
        attempt === undefined
          ? null
          : await signIn
              .continue(request.params.id, attempt, { pasted: request.body.pasted })
              .catch((error: unknown) => {
                if (!(error instanceof SignInError)) {
                  throw error;
                }
                if (error.code === "sign_in_expired") {
                  return null;
                }
                throw new ApiError(
                  400,
                  "sign_in_failed",
                  "The sign-in did not work. Start again and paste the full address from the browser's address bar.",
                );
              });
      if (view === null) {
        throw new ApiError(
          400,
          "sign_in_expired",
          "Start the sign-in again; the previous attempt expired.",
        );
      }
      if (view.status !== "done") {
        throw new ApiError(400, "sign_in_failed", "This sign-in needs more steps.");
      }
      services.scheduler.wake();
      return reply.code(204).send(null);
    },
  );
}
