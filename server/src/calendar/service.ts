import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { PARCEL_STATUSES, type ParcelStatus } from "../domain/parcel.js";
import { localParts } from "../engine/tz.js";

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

function asStatus(value: string | null): ParcelStatus {
  return value !== null && PARCEL_STATUSES.includes(value as ParcelStatus)
    ? (value as ParcelStatus)
    : "unknown";
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
      ])
      .where("archived_at", "is", null)
      .where("removed_at", "is", null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("delivered", "=", 0),
            eb("planned_from", "is not", null),
            eb("planned_from", "<", toIso),
            eb(eb.fn.coalesce("planned_to", "planned_from"), ">=", fromIso),
          ]),
          eb.and([
            eb("delivered", "=", 1),
            eb("delivered_at", ">=", fromIso),
            eb("delivered_at", "<", toIso),
          ]),
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
        if (row.delivered === 1 && row.delivered_at !== null) {
          const start = new Date(row.delivered_at);
          return {
            ...base,
            kind: "delivered",
            start: start.toISOString(),
            end: new Date(start.getTime() + DELIVERED_MARKER_MS).toISOString(),
            allDay: false,
            late: false,
          };
        }
        if (row.planned_from === null) {
          return undefined;
        }
        const start = new Date(row.planned_from);
        // A single point estimate becomes a one-hour slot.
        const end =
          row.planned_to === null
            ? new Date(start.getTime() + 60 * 60_000)
            : new Date(row.planned_to);
        return {
          ...base,
          kind: "expected",
          start: start.toISOString(),
          end: end.toISOString(),
          allDay: isWholeDays(start, end, this.timeZone),
          late: end < now,
        };
      })
      .filter((entry): entry is CalendarEntry => entry !== undefined)
      .sort((a, b) => a.start.localeCompare(b.start));
  }
}
