import type { LookupState, ParcelStatus, Source, SourceState } from "../api/types";
import { UI_LOCALE } from "./locale";

export const STATUS_LABELS: Readonly<Record<ParcelStatus, string>> = {
  registered: "Registered",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  at_pickup_point: "At pickup point",
  delivered: "Delivered",
  returning: "Returning",
  problem: "Problem",
  unknown: "Unknown",
};

export const LOOKUP_LABELS: Readonly<Record<LookupState, string>> = {
  pending: "Waiting for carrier",
  found: "Found",
  not_found: "Not found by carrier",
};

export const SOURCE_STATE_LABELS: Readonly<Record<SourceState, string>> = {
  ok: "OK",
  needs_sign_in: "Needs sign-in",
  error: "Error",
  disabled: "Disabled",
};

export const SOURCE_KIND_LABELS: Readonly<Record<Source["kind"], string>> = {
  account: "account",
  tracking: "tracking",
  shop: "shop",
  mail: "mailbox",
};

const locales = UI_LOCALE;
const dateTime = new Intl.DateTimeFormat(locales, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(locales, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeOnly = new Intl.DateTimeFormat(locales, { timeStyle: "short" });
const relative = new Intl.RelativeTimeFormat(locales, { numeric: "auto" });

export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTime.format(date);
}

/** "Mon 3 Nov, 10:00–12:00", or one side only when the other is missing. */
export function formatWindow(from: string | null, to: string | null): string {
  if (from === null && to === null) {
    return "—";
  }
  const start = from === null ? null : new Date(from);
  const end = to === null ? null : new Date(to);
  if (start !== null && end !== null) {
    const sameDay = start.toDateString() === end.toDateString();
    const wholeDay = sameDay && start.getHours() === 0 && end.getHours() >= 23;
    if (wholeDay) {
      return dateOnly.format(start);
    }
    return sameDay
      ? `${dateOnly.format(start)}, ${timeOnly.format(start)}–${timeOnly.format(end)}`
      : `${dateOnly.format(start)} – ${dateOnly.format(end)}`;
  }
  const only = start ?? end;
  return only === null ? "—" : dateOnly.format(only);
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) {
    return "never";
  }
  const diff = new Date(value).getTime() - now;
  if (Number.isNaN(diff)) {
    return value;
  }
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) {
      return relative.format(Math.round(diff / ms), unit);
    }
  }
  return "just now";
}

const LOOKUP_PHRASES: Readonly<Record<LookupState, string>> = {
  pending: "Waiting for the carrier",
  found: "Found by the carrier",
  not_found: "Not found by the carrier",
};

/**
 * "Found by the carrier 2 days ago, last asked 1 hour ago". Unknown times are left out rather
 * than called "never"; a parcel never asked says so.
 */
export function describeLookup(
  lookup: {
    readonly state: LookupState;
    readonly since: string | null;
    readonly checked_at: string | null;
  },
  now = Date.now(),
): string {
  const since = lookup.since === null ? "" : ` ${formatRelative(lookup.since, now)}`;
  const asked =
    lookup.checked_at === null
      ? "not asked yet"
      : `last asked ${formatRelative(lookup.checked_at, now)}`;
  return `${LOOKUP_PHRASES[lookup.state]}${since}, ${asked}`;
}
