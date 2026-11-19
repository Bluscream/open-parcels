import type { Kysely } from "kysely";
import {
  findCarrier,
  ignoredMail,
  isBoilerplateItemTitle,
  plausibleMailTrackingNumber,
  type Rules,
} from "open-parcels-rules";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";

/** Settings key that marks the one-off cleanup as done. */
export const MAIL_CLEANUP_KEY = "cleanup.mail-false-positives.v1";

export type MailCleanupReason = "placeholder_or_pattern" | "ignored_mail";

export interface MailCleanupResult {
  /** False when an earlier start already ran it. */
  readonly ran: boolean;
  readonly archived: Readonly<Record<MailCleanupReason, number>>;
  readonly boilerplateItemsRemoved: number;
}

interface Candidate {
  readonly id: string;
  readonly carrier: string;
  readonly barcode: string;
  readonly subjects: readonly string[];
}

/** The mail subject was kept as raw status; an ignore rule for the carrier's domains decides. */
function ignoredSubject(rules: Rules, candidate: Candidate): boolean {
  const domains = findCarrier(rules, candidate.carrier)?.domains ?? [];
  return candidate.subjects.some((subject) =>
    domains.some((domain) => ignoredMail(rules, `noreply@${domain}`, subject)),
  );
}

export function cleanupReason(rules: Rules, candidate: Candidate): MailCleanupReason | null {
  if (!plausibleMailTrackingNumber(rules, candidate.carrier, candidate.barcode)) {
    return "placeholder_or_pattern";
  }
  return ignoredSubject(rules, candidate) ? "ignored_mail" : null;
}

/** Active parcels that only mails know about and that no carrier ever found. */
async function candidates(db: Kysely<Database>): Promise<Candidate[]> {
  const rows = await db
    .selectFrom("parcels")
    .select(["id", "carrier", "barcode", "raw_status"])
    .where("archived_at", "is", null)
    .where("removed_at", "is", null)
    .where("lookup_state", "!=", "found")
    .where("manual_status", "is", null)
    // A mail made it; no account or shop lists it. The carrier's tracking source, which startup
    // repair links to every parcel, counts only through lookup_state.
    .where((eb) =>
      eb
        .exists(
          eb
            .selectFrom("parcel_sources")
            .innerJoin("sources", "sources.id", "parcel_sources.source_id")
            .select("parcel_sources.parcel_id")
            .whereRef("parcel_sources.parcel_id", "=", "parcels.id")
            .where("sources.kind", "=", "mail"),
        )
        .and(
          eb.not(
            eb.exists(
              eb
                .selectFrom("parcel_sources")
                .innerJoin("sources", "sources.id", "parcel_sources.source_id")
                .select("parcel_sources.parcel_id")
                .whereRef("parcel_sources.parcel_id", "=", "parcels.id")
                .where("sources.kind", "in", ["account", "shop"]),
            ),
          ),
        ),
    )
    .execute();
  if (rows.length === 0) return [];
  const events = await db
    .selectFrom("parcel_events")
    .select(["parcel_id", "raw_status"])
    .where(
      "parcel_id",
      "in",
      rows.map((row) => row.id),
    )
    .execute();
  return rows.map((row) => ({
    id: row.id,
    carrier: row.carrier,
    barcode: row.barcode,
    subjects: [
      ...(row.raw_status === null ? [] : [row.raw_status]),
      ...events.filter((event) => event.parcel_id === row.id).map((event) => event.raw_status),
    ],
  }));
}

/**
 * One-off and idempotent: archives (never deletes) parcels that earlier, looser mail rules made
 * from mails that were not shipments, records why in `archive_reason`, and drops item titles
 * that were instructions. Marks itself done in the settings table so later starts skip it.
 */
export async function cleanupMailFalsePositives(
  db: Kysely<Database>,
  clock: Clock,
  rules: Rules,
): Promise<MailCleanupResult> {
  const archived: Record<MailCleanupReason, number> = {
    placeholder_or_pattern: 0,
    ignored_mail: 0,
  };
  const done = await db
    .selectFrom("settings")
    .select("key")
    .where("key", "=", MAIL_CLEANUP_KEY)
    .executeTakeFirst();
  if (done !== undefined) {
    return { ran: false, archived, boilerplateItemsRemoved: 0 };
  }
  const now = clock.now().toISOString();
  const found = await candidates(db);
  const items = await db.selectFrom("items").select(["id", "title"]).execute();
  const boilerplate = items.filter((item) => isBoilerplateItemTitle(item.title)).map((i) => i.id);
  await db.transaction().execute(async (trx) => {
    for (const candidate of found) {
      const reason = cleanupReason(rules, candidate);
      if (reason === null) continue;
      archived[reason] += 1;
      await trx
        .updateTable("parcels")
        .set({ archived_at: now, archive_reason: `mail-cleanup: ${reason}`, updated_at: now })
        .where("id", "=", candidate.id)
        .where("archived_at", "is", null)
        .execute();
    }
    if (boilerplate.length > 0) {
      await trx.deleteFrom("items").where("id", "in", boilerplate).execute();
    }
    await trx
      .insertInto("settings")
      .values({ key: MAIL_CLEANUP_KEY, value: JSON.stringify({ at: now }), updated_at: now })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  });
  return { ran: true, archived, boilerplateItemsRemoved: boilerplate.length };
}
