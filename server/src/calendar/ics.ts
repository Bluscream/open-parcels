import ical, { ICalCalendarMethod } from "ical-generator";
import { localParts } from "../engine/tz.js";
import type { CalendarEntry } from "./service.js";

/** The local calendar day of `date`, as a UTC-midnight Date: what an all-day DTSTART needs. */
function localDay(date: Date, timeZone: string, endExclusive: boolean): Date {
  const parts = localParts(date, timeZone);
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  // An inclusive end like 23:59 belongs to that day; ICS all-day ends are exclusive.
  if (endExclusive && !(parts.hour === 0 && parts.minute === 0)) {
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return day;
}

export interface IcsOptions {
  readonly timeZone: string;
  readonly name: string;
  readonly publicUrl: URL | undefined;
}

/** Renders entries as an iCalendar feed. Event UIDs are stable per parcel. */
export function renderIcs(entries: readonly CalendarEntry[], options: IcsOptions): string {
  const calendar = ical({
    name: options.name,
    prodId: { company: "open-parcels", product: "open-parcels", language: "EN" },
    method: ICalCalendarMethod.PUBLISH,
    timezone: options.timeZone,
    // Calendar apps re-fetch at their own pace; this asks for at most hourly.
    ttl: 60 * 60,
  });
  for (const entry of entries) {
    const start = new Date(entry.start);
    const end = new Date(entry.end);
    const parcelUrl =
      options.publicUrl === undefined
        ? null
        : new URL(`parcels/${entry.parcelId}`, options.publicUrl).toString();
    const lines = [
      `Carrier: ${entry.carrier}`,
      `Tracking: ${entry.barcode}`,
      `Status: ${entry.status.replaceAll("_", " ")}`,
    ];
    if (entry.pickupPoint !== null) {
      lines.push(`Pickup point: ${entry.pickupPoint}`);
    }
    calendar.createEvent({
      id: entry.uid,
      summary: entry.kind === "delivered" ? `Delivered: ${entry.title}` : entry.title,
      description: lines.join("\n"),
      ...(entry.allDay
        ? {
            allDay: true,
            start: localDay(start, options.timeZone, false),
            end: localDay(end, options.timeZone, true),
            timezone: null,
          }
        : { start, end }),
      ...(entry.pickupPoint === null ? {} : { location: entry.pickupPoint }),
      ...(parcelUrl === null ? {} : { url: parcelUrl }),
    });
  }
  return calendar.toString();
}
