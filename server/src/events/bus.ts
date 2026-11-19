import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database, OutboxRow } from "../db/schema.js";
import { EVENT_TYPES, type EventType, type OutboxEvent } from "./types.js";

/** How long events stay replayable for clients that reconnect. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REPLAY_LIMIT = 1000;

export type EventListener = (event: OutboxEvent) => void;

/**
 * A message that is pushed to connected clients but never stored or replayed: courier positions.
 * Positions must not end up in history, so they bypass the outbox entirely.
 */
export interface EphemeralMessage {
  readonly type: "parcel.live_position";
  readonly payload: unknown;
}
export type EphemeralListener = (message: EphemeralMessage) => void;

function toEvent(row: OutboxRow): OutboxEvent | undefined {
  if (!EVENT_TYPES.includes(row.type as EventType)) {
    return undefined;
  }
  return {
    seq: row.seq,
    type: row.type as EventType,
    parcelId: row.parcel_id,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

/**
 * Writes an event inside the caller's transaction. It becomes visible to subscribers only after
 * the transaction commits and `EventBus.notify()` runs.
 */
export async function appendEvent(
  trx: Kysely<Database> | Transaction<Database>,
  clock: Clock,
  event: { type: EventType; parcelId: string | null; payload: unknown },
): Promise<void> {
  await trx
    .insertInto("outbox")
    .values({
      type: event.type,
      parcel_id: event.parcelId,
      payload: JSON.stringify(event.payload),
      created_at: isoNow(clock),
    })
    .execute();
}

/** Delivers committed outbox rows to in-process subscribers (SSE clients) in sequence order. */
export class EventBus {
  readonly #listeners = new Set<EventListener>();
  readonly #ephemeral = new Set<EphemeralListener>();
  #lastSeq = 0;
  #pumping: Promise<void> | undefined;
  /** Bumped by every notify(); the pump keeps reading until it has caught up with it. */
  #requested = 0;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Starts after the newest existing row so old events are not re-broadcast on boot. */
  async start(): Promise<void> {
    const row = await this.db
      .selectFrom("outbox")
      .select((eb) => eb.fn.max("seq").as("max"))
      .executeTakeFirst();
    this.#lastSeq = row?.max ?? 0;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeEphemeral(listener: EphemeralListener): () => void {
    this.#ephemeral.add(listener);
    return () => this.#ephemeral.delete(listener);
  }

  publishEphemeral(message: EphemeralMessage): void {
    for (const listener of this.#ephemeral) {
      try {
        listener(message);
      } catch (error) {
        this.logger.error({ err: error }, "Live listener failed.");
      }
    }
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  /** Call after any transaction that appended events. Safe to call concurrently. */
  notify(): Promise<void> {
    this.#requested += 1;
    this.#pumping ??= this.#pump().finally(() => {
      this.#pumping = undefined;
    });
    return this.#pumping;
  }

  async #pump(): Promise<void> {
    let handled = 0;
    while (handled < this.#requested) {
      handled = this.#requested;
      const rows = await this.db
        .selectFrom("outbox")
        .selectAll()
        .where("seq", ">", this.#lastSeq)
        .orderBy("seq")
        .execute();
      for (const row of rows) {
        this.#lastSeq = row.seq;
        const event = toEvent(row);
        if (event !== undefined) {
          this.#emit(event);
        }
      }
    }
  }

  #emit(event: OutboxEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error({ err: error, eventType: event.type }, "Event listener failed.");
      }
    }
  }

  /** The newest seq delivered to subscribers; replays never go past it. */
  get head(): number {
    return this.#lastSeq;
  }

  /** The oldest seq still stored, or undefined when the outbox is empty. */
  async oldestRetained(): Promise<number | undefined> {
    const row = await this.db
      .selectFrom("outbox")
      .select((eb) => eb.fn.min("seq").as("min"))
      .executeTakeFirst();
    return row?.min ?? undefined;
  }

  /**
   * One page of events after `seq` that are still within retention, oldest first, for client
   * replay. `last` is the seq of the last row read (whatever its type), the cursor for the next
   * page; `more` says another page may follow. Callers page until `more` is false.
   */
  async replayPage(
    seq: number,
    limit = REPLAY_LIMIT,
  ): Promise<{ events: OutboxEvent[]; last: number; more: boolean }> {
    const rows = await this.db
      .selectFrom("outbox")
      .selectAll()
      .where("seq", ">", seq)
      .where("seq", "<=", this.#lastSeq)
      .orderBy("seq")
      .limit(limit)
      .execute();
    return {
      events: rows.map(toEvent).filter((event): event is OutboxEvent => event !== undefined),
      last: rows.at(-1)?.seq ?? seq,
      more: rows.length === limit,
    };
  }

  async pruneExpired(): Promise<number> {
    const cutoff = addMs(this.clock.now(), -OUTBOX_RETENTION_MS).toISOString();
    const result = await this.db
      .deleteFrom("outbox")
      .where("created_at", "<", cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
