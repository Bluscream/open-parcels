import type { ParcelSnapshot } from "../plugin/snapshot.js";

/** A date-time that carries its own offset or `Z`, so it names one instant. */
const ZONED_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A stored time in the one form every comparison expects: ISO 8601 UTC with milliseconds. Times
 * are compared as text (SQL and merge rules alike), and `14:30+01:00` sorts after `14:00Z` though
 * it is earlier. Values that name no instant (a bare date, unreadable text) are returned unchanged.
 */
export function toUtc(value: string): string;
export function toUtc(value: string | null): string | null;
export function toUtc(value: string | null): string | null {
  if (value === null || !ZONED_DATE_TIME.test(value.trim())) {
    return value;
  }
  const at = Date.parse(value.trim().replace(" ", "T"));
  return Number.isNaN(at) ? value : new Date(at).toISOString();
}

/** Every time in a snapshot as UTC, so plug-ins that send offsets cannot break the ordering. */
export function utcSnapshot(snapshot: ParcelSnapshot): ParcelSnapshot {
  return {
    ...snapshot,
    deliveredAt: toUtc(snapshot.deliveredAt),
    plannedFrom: toUtc(snapshot.plannedFrom),
    plannedTo: toUtc(snapshot.plannedTo),
    history: snapshot.history.map((event) => ({ ...event, at: toUtc(event.at) })),
    order:
      snapshot.order === null
        ? null
        : { ...snapshot.order, placedAt: toUtc(snapshot.order.placedAt) },
  };
}

/** Milliseconds since the epoch, or NaN for text that names no instant. */
export function instant(value: string): number {
  return Date.parse(value);
}

/**
 * Compares two stored times by the instant they name; falls back to text when either does not
 * parse, so unreadable values still order deterministically.
 */
export function compareTimes(a: string, b: string): number {
  const left = instant(a);
  const right = instant(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left - right;
}
