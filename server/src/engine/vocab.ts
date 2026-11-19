import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";

export interface VocabDeps {
  readonly db: Kysely<Database>;
  readonly bus: EventBus;
  readonly clock: Clock;
}

export interface UnknownValue {
  readonly plugin: string;
  readonly kind: string;
  readonly key: string;
}

/**
 * Masks anything shaped like a tracking, order or customer number (a run of six or more letters
 * and digits holding a digit), so free text such as a mail subject can be recorded as a key.
 */
export function maskIdentifiers(text: string): string {
  return text
    .replace(/\b(?=[\p{L}\d-]*\d)[\p{L}\d-]{6,}\b/gu, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Records an unmapped code or key; warns and fires `vocab.unknown` only the first time. */
export async function recordUnknown(
  deps: VocabDeps,
  value: UnknownValue,
  log: Logger,
): Promise<void> {
  const { plugin, kind } = value;
  const now = isoNow(deps.clock);
  const key = value.key.slice(0, 120);
  const existing = await deps.db
    .selectFrom("unknown_vocab")
    .select("count")
    .where("plugin", "=", plugin)
    .where("kind", "=", kind)
    .where("key", "=", key)
    .executeTakeFirst();
  if (existing !== undefined) {
    await deps.db
      .updateTable("unknown_vocab")
      .set({ count: existing.count + 1, last_seen_at: now })
      .where("plugin", "=", plugin)
      .where("kind", "=", kind)
      .where("key", "=", key)
      .execute();
    return;
  }
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("unknown_vocab")
      .values({ plugin, kind, key, first_seen_at: now, last_seen_at: now, count: 1 })
      .execute();
    await appendEvent(trx, deps.clock, {
      type: "vocab.unknown",
      parcelId: null,
      payload: { plugin, kind, key },
    });
  });
  await deps.bus.notify();
  log.warn({ plugin, kind, key }, "Unrecognised value. Please report it so it can be mapped.");
}
