import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";
import {
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  type SignInInput,
  type SignInStep,
  type SignInTurn,
} from "../plugin/api.js";
import type { HttpPolicy, PluginHttp } from "../plugin/http.js";
import {
  InvalidSourceConfigError,
  type PluginRegistry,
  type RegisteredPlugin,
  type SignInCall,
  type SignInFlowInfo,
} from "./registry.js";
import type { SourceService, SourceView } from "./sources.js";

/** How long a step waits for the user's answer. Approval steps use their own timeout. */
export const ATTEMPT_TTL_MS = 15 * 60_000;
/** Refused codes, wrong pastes and the like before the attempt is dropped. */
export const MAX_FAILURES = 5;

export type SignInErrorCode =
  | "sign_in_expired"
  | "sign_in_timeout"
  | "sign_in_refused"
  | "sign_in_failed"
  | "sign_in_unavailable"
  | "sign_in_wrong_step"
  | "sign_in_poll_too_soon"
  | "no_sign_in"
  | "invalid_source"
  | "not_found";

/** A failure the routes turn into an API error. Messages are safe to show. */
export class SignInError extends Error {
  override readonly name = "SignInError";

  constructor(
    readonly code: SignInErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type AttemptView =
  | {
      readonly status: "step";
      readonly attemptId: string;
      readonly flow: string;
      readonly expiresAt: string;
      readonly step: SignInStep;
    }
  | { readonly status: "done" };

export interface SignInDeps {
  readonly db: Kysely<Database>;
  readonly registry: PluginRegistry;
  readonly sources: SourceService;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly httpFor: (policy: HttpPolicy) => PluginHttp;
}

const storedSchema = z.object({ state: z.unknown(), step: z.looseObject({ kind: z.string() }) });

const attemptAad = (attemptId: string, sourceId: string): string =>
  `sign-in:${attemptId}:${sourceId}`;

/** The keys the step's input must have, or why it cannot take input at all. */
function checkedInput(step: SignInStep, input: SignInInput): SignInInput {
  const missing = (): never => {
    throw new SignInError("sign_in_failed", "Fill in every field of this step.");
  };
  const value = (key: string): string => {
    const raw = input[key];
    return raw === undefined || raw.trim() === "" ? missing() : raw;
  };
  switch (step.kind) {
    case "form":
      return Object.fromEntries(step.fields.map((field) => [field.name, value(field.name)]));
    case "open_url":
      return { pasted: value("pasted").trim() };
    case "email_link":
    case "otp_code":
      return { code: value("code").trim() };
    case "choose_method": {
      const choice = value("choice");
      if (!step.options.some((option) => option.id === choice)) {
        throw new SignInError("sign_in_failed", "Choose one of the offered methods.");
      }
      return { choice };
    }
    case "await_approval":
      throw new SignInError(
        "sign_in_wrong_step",
        "This step waits for an approval; poll it instead of sending input.",
      );
  }
}

/**
 * Interactive sign-ins. The plug-in's state lives encrypted in `sign_in_attempts`, bound to the
 * attempt and its source, and is never logged. One attempt per source; a new start replaces it.
 * A carrier that cannot be reached leaves the attempt as it was, so a network error never sends
 * the user back to the start.
 */
export class SignInService {
  constructor(private readonly deps: SignInDeps) {}

  async flows(sourceId: string): Promise<SignInFlowInfo[]> {
    const { source, plugin } = await this.#source(sourceId);
    return source.kind === "mail" ? [] : plugin.signInFlows(source.kind, source.config);
  }

  async start(sourceId: string, flowId?: string): Promise<AttemptView> {
    const { source, plugin } = await this.#source(sourceId);
    const flows = source.kind === "mail" ? [] : plugin.signInFlows(source.kind, source.config);
    const interactive = flows.filter((flow) => flow.type === "interactive");
    const flow =
      flowId === undefined ? interactive[0] : interactive.find((each) => each.id === flowId);
    if (flow === undefined) {
      throw new SignInError(
        "no_sign_in",
        "This source has no such interactive sign-in; enter its sign-in data directly.",
      );
    }
    await this.#sweep(sourceId);
    const turn = await this.#guarded(null, () =>
      this.#call(plugin, source, { action: "start", flowId: flow.id }),
    );
    return this.#settle(source, flow.id, null, turn, false);
  }

  async continue(sourceId: string, attemptId: string, input: SignInInput): Promise<AttemptView> {
    const { source, plugin } = await this.#source(sourceId);
    const attempt = await this.#load(source.id, attemptId, false);
    const checked = checkedInput(attempt.step, input);
    const turn = await this.#guarded(attempt, () =>
      this.#call(plugin, source, {
        action: "continue",
        flowId: attempt.flow,
        state: attempt.state,
        input: checked,
      }),
    );
    return this.#settle(source, attempt.flow, attempt, turn, false);
  }

  async poll(sourceId: string, attemptId: string): Promise<AttemptView> {
    const { source, plugin } = await this.#source(sourceId);
    const attempt = await this.#load(source.id, attemptId, true);
    if (attempt.step.kind !== "await_approval") {
      throw new SignInError("sign_in_wrong_step", "This step does not wait for an approval.");
    }
    const now = this.deps.clock.now().getTime();
    const notBefore = attempt.pollNotBefore === null ? 0 : Date.parse(attempt.pollNotBefore);
    if (now < notBefore) {
      throw new SignInError(
        "sign_in_poll_too_soon",
        "Polled too soon; wait before asking again.",
        Math.ceil((notBefore - now) / 1000),
      );
    }
    const turn = await this.#guarded(attempt, () =>
      this.#call(plugin, source, { action: "poll", flowId: attempt.flow, state: attempt.state }),
    );
    return this.#settle(source, attempt.flow, attempt, turn, true);
  }

  async cancel(sourceId: string, attemptId: string): Promise<boolean> {
    const result = await this.deps.db
      .deleteFrom("sign_in_attempts")
      .where("id", "=", attemptId)
      .where("source_id", "=", sourceId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** The source's current attempt, for the single-step compatibility routes. */
  async current(sourceId: string): Promise<string | undefined> {
    const row = await this.deps.db
      .selectFrom("sign_in_attempts")
      .select("id")
      .where("source_id", "=", sourceId)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row?.id;
  }

  async #source(sourceId: string): Promise<{ source: SourceView; plugin: RegisteredPlugin }> {
    const source = await this.deps.sources.get(sourceId);
    const plugin = source === undefined ? undefined : this.deps.registry.get(source.plugin);
    if (source === undefined || plugin === undefined) {
      throw new SignInError("not_found", "The source was not found.");
    }
    return { source, plugin };
  }

  async #call(
    plugin: RegisteredPlugin,
    source: SourceView,
    call: Pick<SignInCall, "action" | "flowId" | "state" | "input">,
  ): Promise<SignInTurn<unknown>> {
    if (source.kind === "mail") {
      throw new SignInError("no_sign_in", "Mailboxes sign in with their own form.");
    }
    try {
      return await plugin.signInTurn({
        ...call,
        kind: source.kind,
        rawConfig: source.config,
        http: this.deps.httpFor(plugin.http),
        clock: this.deps.clock,
      });
    } catch (error) {
      // Only the error's type is logged: messages and inputs may hold codes or addresses.
      this.deps.logger.warn(
        {
          plugin: plugin.info.id,
          flow: call.flowId,
          action: call.action,
          error: error instanceof Error ? error.name : "unknown",
        },
        "A sign-in step failed.",
      );
      throw error;
    }
  }

  /** Maps plug-in errors; failures count against the attempt, unreachable carriers do not. */
  async #guarded(
    attempt: LoadedAttempt | null,
    run: () => Promise<SignInTurn<unknown>>,
  ): Promise<SignInTurn<unknown>> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TransientError || error instanceof RateLimitedError) {
        throw new SignInError(
          "sign_in_unavailable",
          "The carrier could not be reached. Your sign-in is kept; try the same step again.",
          error instanceof RateLimitedError ? error.retryAfterSeconds : undefined,
        );
      }
      if (error instanceof InvalidSourceConfigError) {
        throw new SignInError("invalid_source", error.message);
      }
      if (attempt !== null) {
        await this.#fail(attempt);
      }
      throw error instanceof SignInRejectedError
        ? new SignInError("sign_in_refused", "The carrier refused that. Check it and try again.")
        : new SignInError("sign_in_failed", "That did not work. Check it and try again.");
    }
  }

  async #fail(attempt: LoadedAttempt): Promise<void> {
    if (attempt.failures + 1 >= MAX_FAILURES) {
      await this.cancel(attempt.sourceId, attempt.id);
      return;
    }
    await this.deps.db
      .updateTable("sign_in_attempts")
      .set({ failures: attempt.failures + 1 })
      .where("id", "=", attempt.id)
      .execute();
  }

  /** Stores the next step, or the finished secret. */
  async #settle(
    source: SourceView,
    flow: string,
    previous: LoadedAttempt | null,
    turn: SignInTurn<unknown>,
    polled: boolean,
  ): Promise<AttemptView> {
    if ("secret" in turn) {
      await this.deps.db
        .deleteFrom("sign_in_attempts")
        .where("source_id", "=", source.id)
        .execute();
      await this.deps.sources.setSecret(source.id, turn.secret);
      return { status: "done" };
    }
    const now = this.deps.clock.now().getTime();
    const waiting = turn.step.kind === "await_approval" ? turn.step : null;
    // A poll that is still waiting keeps the approval's deadline; anything else gets a fresh one.
    const expiresAt =
      polled && waiting !== null && previous !== null
        ? previous.expiresAt
        : new Date(
            now + (waiting === null ? ATTEMPT_TTL_MS : waiting.timeoutSeconds * 1000),
          ).toISOString();
    const pollNotBefore =
      waiting === null ? null : new Date(now + waiting.pollIntervalSeconds * 1000).toISOString();
    const id = previous?.id ?? randomUUID();
    const blob = this.deps.secrets.encryptJson(
      { state: turn.state, step: turn.step },
      attemptAad(id, source.id),
    );
    if (previous === null) {
      await this.deps.db
        .insertInto("sign_in_attempts")
        .values({
          id,
          source_id: source.id,
          flow,
          blob,
          created_at: isoNow(this.deps.clock),
          expires_at: expiresAt,
          poll_not_before: pollNotBefore,
        })
        .execute();
    } else {
      await this.deps.db
        .updateTable("sign_in_attempts")
        .set({ blob, expires_at: expiresAt, poll_not_before: pollNotBefore })
        .where("id", "=", id)
        .execute();
    }
    return { status: "step", attemptId: id, flow, expiresAt, step: turn.step };
  }

  async #load(sourceId: string, attemptId: string, polling: boolean): Promise<LoadedAttempt> {
    const row = await this.deps.db
      .selectFrom("sign_in_attempts")
      .selectAll()
      .where("id", "=", attemptId)
      .where("source_id", "=", sourceId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SignInError("sign_in_expired", "Start the sign-in again; this attempt is gone.");
    }
    let stored: z.infer<typeof storedSchema>;
    try {
      stored = storedSchema.parse(
        this.deps.secrets.decryptJson(row.blob, attemptAad(row.id, row.source_id)),
      );
    } catch (error) {
      if (!(error instanceof DecryptionError || error instanceof z.ZodError)) {
        throw error;
      }
      // Damaged or moved state: drop it rather than hand garbage to the plug-in.
      this.deps.logger.warn({ source: sourceId }, "A stored sign-in attempt could not be read.");
      await this.cancel(sourceId, attemptId);
      throw new SignInError("sign_in_expired", "Start the sign-in again; this attempt is gone.");
    }
    const step = stored.step as SignInStep;
    if (Date.parse(row.expires_at) <= this.deps.clock.now().getTime()) {
      await this.cancel(sourceId, attemptId);
      throw polling && step.kind === "await_approval"
        ? new SignInError("sign_in_timeout", "The approval did not arrive in time. Start again.")
        : new SignInError("sign_in_expired", "Start the sign-in again; the attempt expired.");
    }
    return {
      id: row.id,
      sourceId,
      flow: row.flow,
      state: stored.state,
      step,
      failures: row.failures,
      expiresAt: row.expires_at,
      pollNotBefore: row.poll_not_before,
    };
  }

  /** Drops this source's attempts and every expired one. */
  async #sweep(sourceId: string): Promise<void> {
    await this.deps.db
      .deleteFrom("sign_in_attempts")
      .where((eb) =>
        eb.or([eb("source_id", "=", sourceId), eb("expires_at", "<=", isoNow(this.deps.clock))]),
      )
      .execute();
  }
}

interface LoadedAttempt {
  readonly id: string;
  readonly sourceId: string;
  readonly flow: string;
  readonly state: unknown;
  readonly step: SignInStep;
  readonly failures: number;
  readonly expiresAt: string;
  readonly pollNotBefore: string | null;
}
