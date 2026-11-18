import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import { DecryptionError, type SecretBox } from "../crypto/secrets.js";
import type { Database, SourceRow } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import {
  CaptchaError,
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  type FetchResult,
  type LiveReading,
  type LiveTarget,
  type PluginLogger,
  type SessionStore,
} from "../plugin/api.js";
import { PluginHttp, type FetchLike, type HostLimiter, type HttpPolicy } from "../plugin/http.js";
import type { FailureKind } from "./policy.js";
import type { LiveTargetOfParcel, Reconciler } from "./reconciler.js";
import {
  InvalidSourceConfigError,
  type BaseContext,
  type PluginRegistry,
  type RegisteredPlugin,
} from "./registry.js";
import { secretAad, sessionAad } from "./sources.js";

export type RunOutcome =
  | {
      readonly ok: true;
      readonly created: number;
      readonly updated: number;
      readonly events: number;
      readonly liveTargets: readonly LiveTargetOfParcel[];
    }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly detail: string;
      readonly retryAfterSeconds?: number;
    };

export interface RunnerDeps {
  readonly db: Kysely<Database>;
  readonly registry: PluginRegistry;
  readonly secrets: SecretBox;
  readonly reconciler: Reconciler;
  readonly limiter: HostLimiter;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
}

function classify(error: unknown): {
  kind: FailureKind;
  detail: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof SignInRejectedError) {
    return { kind: "sign_in_rejected", detail: "The carrier rejected the sign-in. Sign in again." };
  }
  if (error instanceof RateLimitedError) {
    return {
      kind: "rate_limited",
      detail: "The carrier asked us to slow down.",
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  if (error instanceof CaptchaError) {
    return { kind: "captcha", detail: "The carrier showed a captcha; paused for six hours." };
  }
  if (error instanceof InvalidSourceConfigError) {
    return { kind: "invalid_config", detail: error.message };
  }
  if (error instanceof DecryptionError) {
    return {
      kind: "sign_in_rejected",
      detail:
        "The stored sign-in could not be decrypted (was the encryption key changed?). Sign in again.",
    };
  }
  return { kind: "transient", detail: "The last update failed; retrying later." };
}

/** Runs one source: calls its plug-in and hands the result to the reconciler. */
export class SourceRunner {
  #reports: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RunnerDeps) {}

  async run(sourceId: string): Promise<RunOutcome> {
    const { db, registry } = this.deps;
    const row = await db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    const plugin = row === undefined ? undefined : registry.get(row.plugin);
    if (row === undefined || plugin === undefined) {
      return {
        ok: false,
        kind: "invalid_config",
        detail: "The source's carrier plug-in is not installed.",
      };
    }
    const log = this.deps.logger.child({ plugin: row.plugin, source: row.id });
    try {
      const { result, asked } = await this.#fetch(row, plugin, log);
      // Let this run's unknown-value reports land before its result is applied.
      await this.#reports;
      const summary = await this.deps.reconciler.ingest(row.id, result, asked);
      if (asked.length > 0) {
        // Counts only: the codes themselves never go to the log.
        log.info(
          { asked: summary.asked, found: summary.found },
          "Asked the carrier about tracked codes.",
        );
      }
      return { ok: true, ...summary };
    } catch (error) {
      const outcome = classify(error);
      if (outcome.kind === "transient" && !(error instanceof TransientError)) {
        // Not a failure the plug-in signalled: most likely a bug. Keep the stack for diagnosis.
        log.error({ err: error }, "Source run failed unexpectedly.");
      } else {
        log.warn(
          { failure: outcome.kind, error: error instanceof Error ? error.message : String(error) },
          "Source run failed.",
        );
      }
      return { ok: false, ...outcome };
    }
  }

  /** A rate-limited HTTP client for a plug-in, for work outside a source run (sign-in). */
  httpFor(policy: HttpPolicy): PluginHttp {
    return new PluginHttp(policy, this.deps.limiter, this.deps.clock, this.deps.fetchImpl);
  }

  /**
   * Reads one live courier map. Errors propagate to the live tracker, which owns the retry rules;
   * none of them ever triggers a new sign-in here.
   */
  async readLive(sourceId: string, target: LiveTarget): Promise<LiveReading | null> {
    const row = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    const plugin = row === undefined ? undefined : this.deps.registry.get(row.plugin);
    if (row === undefined || plugin?.canReadLive !== true) {
      return null;
    }
    const { base, config, secret } = this.#prepare(
      row,
      plugin,
      this.deps.logger.child({ plugin: row.plugin, source: row.id, live: true }),
    );
    return plugin.readLive(base, config, secret, target);
  }

  /** Runs the plug-in; for a tracking source also returns the ids of the parcels it asked about. */
  async #fetch(
    row: SourceRow,
    plugin: RegisteredPlugin,
    log: Logger,
  ): Promise<{ result: FetchResult; asked: readonly string[] }> {
    const { base, config, secret } = this.#prepare(row, plugin, log);
    if (row.kind !== "tracking") {
      return { result: await plugin.fetchAccount(base, config, secret), asked: [] };
    }
    const tracked = await this.#trackedParcels(row.id);
    if (tracked.length === 0) {
      return { result: { snapshots: [], complete: false }, asked: [] };
    }
    const result = await plugin.track(
      base,
      config,
      secret,
      tracked.map((parcel) => parcel.barcode),
    );
    return { result, asked: tracked.map((parcel) => parcel.id) };
  }

  #prepare(
    row: SourceRow,
    plugin: RegisteredPlugin,
    log: Logger,
  ): { base: BaseContext; config: unknown; secret: unknown } {
    const secret =
      row.secret_blob === null
        ? null
        : this.deps.secrets.decryptJson(row.secret_blob, secretAad(row.id));
    const config = JSON.parse(row.config) as unknown;
    const base: BaseContext = {
      sourceId: row.id,
      http: new PluginHttp(plugin.http, this.deps.limiter, this.deps.clock, this.deps.fetchImpl),
      clock: this.deps.clock,
      logger: this.#pluginLogger(log),
      session: this.#sessionStore(row),
      reportUnknown: (kind, key) => {
        // Reports are written one after another (two reports of a new key would otherwise race
        // into a duplicate insert) and never fail the run.
        this.#reports = this.#reports
          .then(() => this.#reportUnknown(row.plugin, kind, key, log))
          .catch((error: unknown) => {
            log.error({ err: error }, "Recording an unrecognised value failed.");
          });
      },
    };
    return { base, config, secret };
  }

  async #trackedParcels(sourceId: string): Promise<{ id: string; barcode: string }[]> {
    return this.deps.db
      .selectFrom("parcel_sources")
      .innerJoin("parcels", "parcels.id", "parcel_sources.parcel_id")
      .select(["parcels.id", "parcels.barcode"])
      .where("parcel_sources.source_id", "=", sourceId)
      .where("parcels.delivered", "=", 0)
      .where("parcels.archived_at", "is", null)
      .execute();
  }

  #pluginLogger(log: Logger): PluginLogger {
    return {
      debug: (context, message) => {
        log.debug(context, message);
      },
      info: (context, message) => {
        log.info(context, message);
      },
      warn: (context, message) => {
        log.warn(context, message);
      },
    };
  }

  #sessionStore(row: SourceRow): SessionStore {
    let cached: unknown =
      row.session_blob === null
        ? undefined
        : this.deps.secrets.decryptJson(row.session_blob, sessionAad(row.id));
    return {
      load: () => cached,
      save: async (value) => {
        cached = value;
        await this.deps.db
          .updateTable("sources")
          .set({
            session_blob: this.deps.secrets.encryptJson(value, sessionAad(row.id)),
            updated_at: isoNow(this.deps.clock),
          })
          .where("id", "=", row.id)
          .execute();
      },
    };
  }

  /** Records an unmapped code or key; warns and fires `vocab.unknown` only the first time. */
  async #reportUnknown(plugin: string, kind: string, key: string, log: Logger): Promise<void> {
    const now = isoNow(this.deps.clock);
    const safeKey = key.slice(0, 120);
    const existing = await this.deps.db
      .selectFrom("unknown_vocab")
      .select("count")
      .where("plugin", "=", plugin)
      .where("kind", "=", kind)
      .where("key", "=", safeKey)
      .executeTakeFirst();
    if (existing !== undefined) {
      await this.deps.db
        .updateTable("unknown_vocab")
        .set({ count: existing.count + 1, last_seen_at: now })
        .where("plugin", "=", plugin)
        .where("kind", "=", kind)
        .where("key", "=", safeKey)
        .execute();
      return;
    }
    await this.deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("unknown_vocab")
        .values({ plugin, kind, key: safeKey, first_seen_at: now, last_seen_at: now, count: 1 })
        .execute();
      await appendEvent(trx, this.deps.clock, {
        type: "vocab.unknown",
        parcelId: null,
        payload: { plugin, kind, key: safeKey },
      });
    });
    await this.deps.bus.notify();
    log.warn(
      { kind, key: safeKey },
      "Unrecognised value from the carrier. Please report it so it can be mapped.",
    );
  }
}
