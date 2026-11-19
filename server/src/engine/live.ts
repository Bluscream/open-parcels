import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import type { LiveState } from "../domain/parcel.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, type LivePosition, type Presentation } from "../parcels/repository.js";
import { RateLimitedError, type LiveReading, type LiveTarget } from "../plugin/api.js";
import type { SourceRunner } from "./runner.js";

/** Cadence of the carrier's own tracking page while a map session is open. */
export const LIVE_FAST_MS = 30_000;
/** Probe for a session on parcels out for delivery that have no map yet. */
export const LIVE_PROBE_MS = 5 * 60_000;
/** Failed passes in a row before reading stops until the next full poll, as the carrier's page does. */
export const LIVE_MAX_FAILURES = 3;

interface Session {
  readonly state: LiveState;
  readonly stopsAway: number | null;
}

interface Tracked {
  readonly sourceId: string;
  readonly target: LiveTarget;
}

const onRoad = (session: Session | undefined): boolean =>
  session !== undefined && (session.state === "en_route" || session.state === "next_stop");

export interface LiveDeps {
  readonly db: Kysely<Database>;
  readonly runner: SourceRunner;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Asks for an immediate full poll of a source, so `delivered` follows within a minute. */
  readonly refreshSource: (sourceId: string) => Promise<void>;
  readonly presentation: Presentation;
}

/**
 * Follows couriers on the last mile. Readings update the parcel's `live` value; events fire only
 * when a session starts or ends, its state changes, or the stop count changes, never for a
 * position alone. Positions live in memory and are pushed to clients as ephemeral messages.
 */
export class LiveTracker {
  readonly #targets = new Map<string, Tracked>();
  readonly #sessions = new Map<string, Session>();
  readonly #positions = new Map<string, LivePosition>();
  readonly #failures = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  /** A pass is running; a wake meanwhile only sets `#rerun`. */
  #running = false;
  #rerun = false;

  constructor(private readonly deps: LiveDeps) {}

  /** Position overlay for API reads; only set while the courier is en route. */
  position(parcelId: string): LivePosition | undefined {
    return this.#positions.get(parcelId);
  }

  /** Replaces a source's targets after a full poll; a full poll also lifts the failure stop. */
  setTargets(sourceId: string, targets: readonly { parcelId: string; target: LiveTarget }[]): void {
    for (const [parcelId, tracked] of this.#targets) {
      if (tracked.sourceId === sourceId) {
        this.#targets.delete(parcelId);
      }
    }
    for (const { parcelId, target } of targets) {
      this.#targets.set(parcelId, { sourceId, target });
    }
    this.#failures.delete(sourceId);
    this.wake();
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Starts a pass soon. There is only ever one chain of passes: a wake while a pass runs asks for
   * one more pass after it instead of starting a second chain, and a wake while the next pass is
   * already scheduled leaves that one in place.
   */
  wake(): void {
    if (this.#stopped) {
      return;
    }
    if (this.#running) {
      this.#rerun = true;
      return;
    }
    if (this.#timer === undefined) {
      this.#schedule(0);
    }
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run();
    }, delayMs);
    this.#timer.unref();
  }

  /** Whether a wake arrived during the pass; read after the await, where it may have changed. */
  #rerunAsked(): boolean {
    return this.#rerun;
  }

  async #run(): Promise<void> {
    this.#running = true;
    this.#rerun = false;
    let next: number | null;
    try {
      next = await this.pass();
    } catch (error) {
      this.deps.logger.error({ err: error }, "Live tracking pass failed.");
      next = LIVE_PROBE_MS;
    } finally {
      this.#running = false;
    }
    if (this.#stopped) {
      return;
    }
    if (this.#rerunAsked()) {
      // Something changed during the pass (new targets, a wake): look again right away.
      this.#schedule(0);
    } else if (next !== null) {
      this.#schedule(next);
    }
  }

  /** Reads every candidate once. Returns the delay until the next pass, or null when idle. */
  async pass(): Promise<number | null> {
    const candidates = await this.#candidates();
    if (candidates.length === 0) {
      return null;
    }
    let retryAfterMs = 0;
    const failedSources = new Set<string>();
    for (const [parcelId, tracked] of candidates) {
      if (failedSources.has(tracked.sourceId)) {
        continue;
      }
      try {
        const reading = await this.deps.runner.readLive(tracked.sourceId, tracked.target);
        await this.#apply(parcelId, tracked.sourceId, reading);
      } catch (error) {
        failedSources.add(tracked.sourceId);
        if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
          retryAfterMs = Math.max(retryAfterMs, error.retryAfterSeconds * 1000);
        }
        this.deps.logger.warn(
          { source: tracked.sourceId, error: error instanceof Error ? error.name : "unknown" },
          "Reading the courier map failed.",
        );
      }
    }
    for (const sourceId of new Set(candidates.map(([, tracked]) => tracked.sourceId))) {
      this.#failures.set(
        sourceId,
        failedSources.has(sourceId) ? (this.#failures.get(sourceId) ?? 0) + 1 : 0,
      );
    }
    const fast = candidates.some(
      ([parcelId, tracked]) => onRoad(this.#sessions.get(parcelId)) || tracked.target.mapShown,
    );
    return Math.max(fast ? LIVE_FAST_MS : LIVE_PROBE_MS, retryAfterMs);
  }

  async #candidates(): Promise<[string, Tracked][]> {
    if (this.#targets.size === 0) {
      return [];
    }
    const rows = await this.deps.db
      .selectFrom("parcels")
      .select(["id", "status", "delivered"])
      .where("id", "in", [...this.#targets.keys()])
      .execute();
    // A parcel deleted since its source's last poll is no longer followed.
    const present = new Set(rows.map((row) => row.id));
    for (const parcelId of [...this.#targets.keys()]) {
      if (!present.has(parcelId)) {
        await this.#forget(parcelId);
      }
    }
    const result: [string, Tracked][] = [];
    for (const row of rows) {
      const tracked = this.#targets.get(row.id);
      if (
        tracked === undefined ||
        (this.#failures.get(tracked.sourceId) ?? 0) >= LIVE_MAX_FAILURES
      ) {
        continue;
      }
      if (row.delivered === 1) {
        await this.#forget(row.id);
        continue;
      }
      const session = this.#sessions.get(row.id);
      const ended = session !== undefined && !onRoad(session);
      // An ended session is not re-read while the parcel is still listed out for delivery,
      // so one delivery never produces two "ended" transitions.
      if (ended && row.status === "out_for_delivery") {
        continue;
      }
      if (onRoad(session) || tracked.target.mapShown || row.status === "out_for_delivery") {
        result.push([row.id, tracked]);
      }
    }
    return result;
  }

  async #apply(parcelId: string, sourceId: string, reading: LiveReading | null): Promise<void> {
    const previous = this.#sessions.get(parcelId);
    if (reading === null) {
      if (onRoad(previous)) {
        await this.#record(parcelId, previous, null);
        await this.deps.refreshSource(sourceId);
      }
      return;
    }
    const session: Session = { state: reading.state, stopsAway: reading.stopsAway };
    this.#sessions.set(parcelId, session);
    // From `next_stop` on, the position would point at the destination; it is never published.
    const hasFix =
      reading.state === "en_route" && reading.latitude !== null && reading.longitude !== null;
    if (hasFix) {
      const position: LivePosition = {
        latitude: reading.latitude,
        longitude: reading.longitude,
        accuracy: reading.accuracy,
        positionAt: reading.positionAt,
      };
      this.#positions.set(parcelId, position);
      this.deps.bus.publishEphemeral({
        type: "parcel.live_position",
        payload: { parcel_id: parcelId, ...position, stops_away: reading.stopsAway },
      });
    } else {
      this.#positions.delete(parcelId);
    }
    const changed = previous?.state !== session.state || previous.stopsAway !== session.stopsAway;
    await this.#upsertState(parcelId, reading);
    if (changed) {
      await this.#record(parcelId, previous, session);
    }
    if (!onRoad(session) && (previous === undefined || onRoad(previous))) {
      await this.deps.refreshSource(sourceId);
    }
  }

  async #upsertState(parcelId: string, reading: LiveReading): Promise<void> {
    const now = isoNow(this.deps.clock);
    const values = {
      state: reading.state,
      stops_away: reading.stopsAway,
      message: reading.message,
      position_at: reading.positionAt,
      updated_at: now,
    };
    await this.deps.db
      .insertInto("live_state")
      .values({ parcel_id: parcelId, ...values })
      .onConflict((oc) => oc.column("parcel_id").doUpdateSet(values))
      .execute();
  }

  async #record(
    parcelId: string,
    previous: Session | undefined,
    next: Session | null,
  ): Promise<void> {
    if (next === null) {
      this.#sessions.delete(parcelId);
      this.#positions.delete(parcelId);
      await this.deps.db.deleteFrom("live_state").where("parcel_id", "=", parcelId).execute();
    }
    await this.deps.db.transaction().execute(async (trx) => {
      const parcel = await new ParcelRepository(trx, this.deps.presentation).get(parcelId);
      if (parcel === undefined) {
        return;
      }
      await appendEvent(trx, this.deps.clock, {
        type: "parcel.live_updated",
        parcelId,
        payload: parcelEventPayload(parcel, {
          old_live_state: previous?.state ?? null,
          new_live_state: next?.state ?? null,
          old_stops_away: previous?.stopsAway ?? null,
          new_stops_away: next?.stopsAway ?? null,
        }),
      });
    });
    await this.deps.bus.notify();
  }

  async #forget(parcelId: string): Promise<void> {
    this.#targets.delete(parcelId);
    this.#sessions.delete(parcelId);
    this.#positions.delete(parcelId);
    await this.deps.db.deleteFrom("live_state").where("parcel_id", "=", parcelId).execute();
  }
}
