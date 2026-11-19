import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { effectiveDelivered, PARCEL_STATUSES, type ParcelStatus } from "../domain/parcel.js";
import { localParts, nextLocalMidnight } from "../engine/tz.js";

/** How long a delivered parcel's marker lasts on the calendar. */
const DELIVERED_MARKER_MS = 30 * 60_000;

/**
 * One calendar entry. The Calendar tab and the ICS feed both read these, so they can never
 * disagree. `uid` is stable per parcel: when an all-day estimate narrows to a time window, the
 * same entry changes instead of a second one appearing.
 */
export interface CalendarEntry {
  readonly uid: string;
  readonly parcelId: string;
  readonly title: string;
  readonly carrier: string;
  readonly barcode: string;
  readonly status: ParcelStatus;
  readonly kind: "expected" | "delivered";
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /**
   * For all-day entries, the local calendar days as `YYYY-MM-DD`, the end exclusive (as in ICS).
   * Readers use these instead of `start`/`end`, so the days never shift with the reader's zone.
   */
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** Undelivered and its window has passed. */
  readonly late: boolean;
  readonly imageUrl: string | null;
  readonly url: string | null;
  readonly pickupPoint: string | null;
}

/**
 * A window counts as whole days when it starts at local midnight and ends at a later local
 * midnight (exclusive) or at 23:59(:59) of a day (inclusive).
 */
export function isWholeDays(start: Date, end: Date, timeZone: string): boolean {
  if (end <= start) {
    return false;
  }
  const from = localParts(start, timeZone);
  const to = localParts(end, timeZone);
  const startsAtMidnight = from.hour === 0 && from.minute === 0;
  const endsAtMidnight = to.hour === 0 && to.minute === 0;
  const endsAtDayEnd = to.hour === 23 && to.minute === 59;
  return startsAtMidnight && (endsAtMidnight || endsAtDayEnd);
}

/** A time at local midnight carries a date only: the source knew the day, not the hour. */
export function isDateOnly(at: Date, timeZone: string): boolean {
  const parts = localParts(at, timeZone);
  return parts.hour === 0 && parts.minute === 0;
}

function isoDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/**
 * The local days an all-day entry covers, end exclusive. An end that is not at midnight (an
 * inclusive 23:59) belongs to its own day, so the exclusive end is the day after it.
 */
export function allDayRange(
  start: Date,
  end: Date,
  timeZone: string,
): { startDate: string; endDate: string } {
  const from = localParts(start, timeZone);
  const to = localParts(end, timeZone);
  const startDate = isoDay(from.year, from.month, from.day);
  const endsAtMidnight = to.hour === 0 && to.minute === 0;
  let endDate = isoDay(to.year, to.month, to.day + (endsAtMidnight ? 0 : 1));
  if (endDate <= startDate) {
    endDate = isoDay(from.year, from.month, from.day + 1);
  }
  return { startDate, endDate };
}

function asStatus(value: string | null): ParcelStatus {
  return asManual(value) ?? "unknown";
}

function asManual(value: string | null): ParcelStatus | null {
  return value !== null && PARCEL_STATUSES.includes(value as ParcelStatus)
    ? (value as ParcelStatus)
    : null;
}

export class CalendarService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {}

  async entries(from: Date, to: Date): Promise<CalendarEntry[]> {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const rows = await this.db
      .selectFrom("parcels")
      .select([
        "id",
        "carrier",
        "barcode",
        "status",
        "manual_status",
        "delivered",
        "delivered_at",
        "planned_from",
        "planned_to",
        "label",
        "url",
        "pickup_point",
        "archived_at",
      ])
      // A calendar is a history too: archived deliveries stay (decided per row below). Deleted
      // parcels are gone from the table; removed ones (vanished undelivered) never show.
      .where("removed_at", "is", null)
      // Candidates only; whether a parcel counts as delivered (a manual status wins) is decided
      // below, per row.
      .where((eb) =>
        eb.or([
          eb.and([
            eb("planned_from", "is not", null),
            eb("planned_from", "<", toIso),
            eb(eb.fn.coalesce("planned_to", "planned_from"), ">=", fromIso),
          ]),
          eb.and([eb("delivered_at", ">=", fromIso), eb("delivered_at", "<", toIso)]),
        ]),
      )
      .execute();
    const items =
      rows.length === 0
        ? []
        : await this.db
            .selectFrom("items")
            .select(["parcel_id", "title", "image_ref", "position"])
            .where(
              "parcel_id",
              "in",
              rows.map((row) => row.id),
            )
            .orderBy("position")
            .execute();
    const now = this.clock.now();
    return rows
      .map((row): CalendarEntry | undefined => {
        const own = items.filter((item) => item.parcel_id === row.id);
        const first = own[0];
        const title =
          row.label ??
          // The carrier is shown next to the title by each reader, so it is not repeated here.
          (first === undefined
            ? row.barcode
            : own.length > 1
              ? `${first.title} +${own.length - 1}`
              : first.title);
        const base = {
          uid: `${row.id}@open-parcels`,
          parcelId: row.id,
          title,
          carrier: row.carrier,
          barcode: row.barcode,
          status: asStatus(row.manual_status ?? row.status),
          imageUrl: first?.image_ref ?? null,
          url: row.url,
          pickupPoint: row.pickup_point,
        };
        const delivered = effectiveDelivered(row.delivered === 1, asManual(row.manual_status));
        if (delivered) {
          if (
            row.delivered_at === null ||
            row.delivered_at < fromIso ||
            row.delivered_at >= toIso
          ) {
            return undefined;
          }
          const start = new Date(row.delivered_at);
          // A delivery known only by its day is that whole day, not half an hour at midnight.
          const dateOnly = isDateOnly(start, this.timeZone);
          // The next local midnight, not 24 hours on: a daylight-saving day has 23 or 25.
          const end = dateOnly
            ? nextLocalMidnight(start, this.timeZone)
            : new Date(start.getTime() + DELIVERED_MARKER_MS);
          return { ...base, kind: "delivered", late: false, ...this.#span(start, end, dateOnly) };
        }
        // Archived parcels stay in the calendar only as past deliveries.
        if (row.archived_at !== null || row.planned_from === null || row.planned_from >= toIso) {
          return undefined;
        }
        const start = new Date(row.planned_from);
        // A date without a time is that whole day; another single point estimate is an hour.
        const pointIsDay = row.planned_to === null && isDateOnly(start, this.timeZone);
        const end =
          row.planned_to !== null
            ? new Date(row.planned_to)
            : pointIsDay
              ? nextLocalMidnight(start, this.timeZone)
              : new Date(start.getTime() + 60 * 60_000);
        if (end.toISOString() < fromIso) {
          return undefined;
        }
        return {
          ...base,
          kind: "expected",
          late: end < now,
          ...this.#span(start, end, pointIsDay || isWholeDays(start, end, this.timeZone)),
        };
      })
      .filter((entry): entry is CalendarEntry => entry !== undefined)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  #span(start: Date, end: Date, allDay: boolean) {
    const days = allDay ? allDayRange(start, end, this.timeZone) : null;
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      allDay,
      startDate: days?.startDate ?? null,
      endDate: days?.endDate ?? null,
    };
  }
}
