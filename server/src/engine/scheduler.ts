import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database, SourceRow } from "../db/schema.js";
import { PARCEL_STATUSES, type ParcelStatus } from "../domain/parcel.js";
import {
  delayAfterFailure,
  nextRunAfterSuccess,
  staggerMinutes,
  type ActiveParcel,
} from "./policy.js";
import type { LiveTargetOfParcel, Reconciler } from "./reconciler.js";
import type { RunOutcome, SourceRunner } from "./runner.js";
import type { SourceService } from "./sources.js";

/** Upper bound on the timer, so removals are judged and clock changes picked up regularly. */
const MAX_SLEEP_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 3;

export interface SchedulerDeps {
  readonly db: Kysely<Database>;
  readonly runner: SourceRunner;
  readonly sources: SourceService;
  readonly reconciler: Reconciler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timeZone: string;
  /** Night-time quiet window, defaults to on. */
  readonly quietWindow?: boolean;
  readonly installId: string;
  readonly concurrency?: number;
  /** Called after each successful run with the parcels the carrier can show on a courier map. */
  readonly onRunSucceeded?: (sourceId: string, liveTargets: readonly LiveTargetOfParcel[]) => void;
  /** A plug-in's fixed time between runs, if it has one. */
  readonly pollIntervalOf?: (plugin: string) => number | null;
}

function asStatus(value: string): ParcelStatus {
  return PARCEL_STATUSES.includes(value as ParcelStatus) ? (value as ParcelStatus) : "unknown";
}

/**
 * Decides when each source runs and runs it. One run per source at a time, a few sources in
 * parallel. The next run time is stored, so a restart resumes the schedule instead of polling
 * every carrier at once.
 */
export class Scheduler {
  readonly #running = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    this.#stopped = false;
    this.#arm(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Re-evaluates the timer, e.g. after a source was asked to run now. */
  wake(): void {
    if (!this.#stopped) {
      this.#arm(0);
    }
  }

  #arm(delayMs: number): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#cycle().catch((error: unknown) => {
        this.deps.logger.error({ err: error }, "Scheduler cycle failed.");
        this.#arm(MAX_SLEEP_MS);
      });
    }, delayMs);
    // The scheduler must never keep the process alive on its own.
    this.#timer.unref();
  }

  async #cycle(): Promise<void> {
    await this.runDue();
    await this.deps.reconciler.judgeRemovals();
    if (!this.#stopped) {
      this.#arm(await this.#sleepUntilNext());
    }
  }

  async #sleepUntilNext(): Promise<number> {
    const next = await this.deps.db
      .selectFrom("sources")
      .select((eb) => eb.fn.min("next_run_at").as("next"))
      .where("state", "in", ["ok", "error"])
      .where("kind", "!=", "mail")
      .where("next_run_at", "is not", null)
      .executeTakeFirst();
    if (next?.next === undefined || next.next === null) {
      return MAX_SLEEP_MS;
    }
    return Math.max(
      0,
      Math.min(MAX_SLEEP_MS, Date.parse(next.next) - this.deps.clock.now().getTime()),
    );
  }

  /** Runs every source that is due now. Returns how many ran. */
  async runDue(): Promise<number> {
    const due = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("state", "in", ["ok", "error"])
      .where("kind", "!=", "mail")
      .where("next_run_at", "<=", isoNow(this.deps.clock))
      .orderBy("next_run_at")
      .execute();
    const queue = due.filter((source) => !this.#running.has(source.id));
    const workers = Array.from(
      { length: Math.min(this.deps.concurrency ?? DEFAULT_CONCURRENCY, queue.length) },
      async () => {
        for (let source = queue.shift(); source !== undefined; source = queue.shift()) {
          await this.#runOne(source);
        }
      },
    );
    await Promise.all(workers);
    return due.length;
  }

  async #runOne(source: SourceRow): Promise<void> {
    this.#running.add(source.id);
    try {
      const outcome = await this.deps.runner.run(source.id);
      await this.#record(source, outcome);
      await this.#announce(source, outcome);
    } finally {
      this.#running.delete(source.id);
    }
  }

  async #record(source: SourceRow, outcome: RunOutcome): Promise<void> {
    const now = this.deps.clock.now();
    if (outcome.ok) {
      this.deps.onRunSucceeded?.(source.id, outcome.liveTargets);
      const next = nextRunAfterSuccess({
        now,
        timeZone: this.deps.timeZone,
        quietWindow: this.deps.quietWindow ?? true,
        kind: source.kind,
        staggerMinutes: staggerMinutes(`${this.deps.installId}:${source.id}`),
        active: await this.#activeParcels(source.id),
        fixedIntervalMs: this.deps.pollIntervalOf?.(source.plugin) ?? null,
      });
      await this.deps.db
        .updateTable("sources")
        .set({
          consecutive_failures: 0,
          backoff_until: null,
          next_run_at: next?.toISOString() ?? null,
          last_run_at: now.toISOString(),
          // A run that deliberately did nothing is no success to report.
          ...(outcome.idle === undefined ? { last_ok_at: now.toISOString() } : {}),
        })
        .where("id", "=", source.id)
        .execute();
      const detail = outcome.idle ?? null;
      if (source.state !== "ok" || source.state_detail !== detail) {
        await this.deps.sources.setState(source.id, "ok", detail);
      }
      return;
    }
    const failures = source.consecutive_failures + 1;
    const delay = delayAfterFailure(outcome.kind, failures, outcome.retryAfterSeconds);
    const next = delay === null ? null : new Date(now.getTime() + delay).toISOString();
    await this.deps.db
      .updateTable("sources")
      .set({
        consecutive_failures: failures,
        // A wait the carrier imposed (its 429, a captcha) binds manual syncs too; our own retry
        // delay after a network error does not, so the user can always try again by hand.
        backoff_until: outcome.kind === "rate_limited" || outcome.kind === "captcha" ? next : null,
        next_run_at: next,
        last_run_at: now.toISOString(),
      })
      .where("id", "=", source.id)
      .execute();
    await this.deps.sources.setState(
      source.id,
      outcome.kind === "sign_in_rejected" ? "needs_sign_in" : "error",
      outcome.detail,
    );
  }

  /**
   * Fires `source.run_finished` after every run, so clients showing the source (its last run,
   * next run and counts) refresh even when its state did not change.
   */
  async #announce(source: SourceRow, outcome: RunOutcome): Promise<void> {
    await this.deps.sources.announceRun(source.id, outcome.ok);
  }

  async #activeParcels(sourceId: string): Promise<ActiveParcel[]> {
    const rows = await this.deps.db
      .selectFrom("parcel_sources")
      .innerJoin("parcels", "parcels.id", "parcel_sources.parcel_id")
      .select(["parcels.status", "parcels.planned_from"])
      .where("parcel_sources.source_id", "=", sourceId)
      .where("parcels.delivered", "=", 0)
      .where("parcels.archived_at", "is", null)
      .where("parcels.removed_at", "is", null)
      .execute();
    return rows.map((row) => ({ status: asStatus(row.status), plannedFrom: row.planned_from }));
  }
}
