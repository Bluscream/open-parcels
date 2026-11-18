import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";

const DAY = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Delivered parcels leave the default lists this many days after delivery. */
  readonly archiveAfterDays: number;
  /** Archived parcels, with their history and items, are deleted this many days after archiving. */
  readonly deleteAfterDays: number;
  /** Raw carrier payloads are dropped this many days after delivery. */
  readonly rawAfterDays: number;
  /**
   * Undelivered parcels the carrier has answered "not found" for this many days without a break
   * are archived (not deleted, and no `parcel.removed`). 0 turns it off. A manual status keeps
   * the parcel.
   */
  readonly notFoundArchiveDays: number;
}

export interface RetentionResult {
  readonly archived: number;
  readonly notFoundArchived: number;
  readonly deleted: number;
  readonly rawDropped: number;
}

/** Applies the retention policy. Parcels with a manual status are archived like any other. */
export async function applyRetention(
  db: Kysely<Database>,
  clock: Clock,
  policy: RetentionPolicy,
): Promise<RetentionResult> {
  const now = clock.now().getTime();
  const iso = (daysAgo: number): string => new Date(now - daysAgo * DAY).toISOString();
  const archived = await db
    .updateTable("parcels")
    .set({ archived_at: new Date(now).toISOString() })
    .where("delivered", "=", 1)
    .where("archived_at", "is", null)
    .where("delivered_at", "<", iso(policy.archiveAfterDays))
    .executeTakeFirst();
  const notFoundArchived =
    policy.notFoundArchiveDays <= 0
      ? 0
      : Number(
          (
            await db
              .updateTable("parcels")
              .set({ archived_at: new Date(now).toISOString() })
              .where("delivered", "=", 0)
              .where("archived_at", "is", null)
              .where("manual_status", "is", null)
              .where("lookup_state", "=", "not_found")
              .where("lookup_since", "<", iso(policy.notFoundArchiveDays))
              .executeTakeFirst()
          ).numUpdatedRows,
        );
  const deleted = await db
    .deleteFrom("parcels")
    .where("archived_at", "<", iso(policy.deleteAfterDays))
    .executeTakeFirst();
  const rawDropped = await db
    .deleteFrom("parcel_raw")
    .where("parcel_id", "in", (eb) =>
      eb
        .selectFrom("parcels")
        .select("id")
        .where("delivered", "=", 1)
        .where("delivered_at", "<", iso(policy.rawAfterDays)),
    )
    .executeTakeFirst();
  return {
    archived: Number(archived.numUpdatedRows),
    notFoundArchived,
    deleted: Number(deleted.numDeletedRows),
    rawDropped: Number(rawDropped.numDeletedRows),
  };
}
