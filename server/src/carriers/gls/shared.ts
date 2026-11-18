import { loadRules, mapStatus, trackingUrl, type MappedStatus } from "open-parcels-rules";
import type { SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "gls";
export const NL_HOST = "apm.gls.nl";
export const GROUP_HOSTS = ["gls-group.com", "gls-group.eu"] as const;

/** At most this many history entries per parcel, newest kept. */
export const HISTORY_LIMIT = 20;

export interface GroupCountry {
  readonly host: (typeof GROUP_HOSTS)[number];
  /** The `{ISO2}/{lang}` path segment of the group tracking service. */
  readonly locale: string;
  /** Lookup type tried first on the fallback endpoint; the other one is tried once after. */
  readonly preferredType: "" | "NAT";
  readonly timeZone: string;
}

const group = (
  locale: string,
  timeZone: string,
  host: GroupCountry["host"] = "gls-group.com",
  preferredType: GroupCountry["preferredType"] = "",
): GroupCountry => ({ host, locale, preferredType, timeZone });

/** Countries served by the pan-EU group tracking service. */
export const GROUP_COUNTRIES: Readonly<Record<string, GroupCountry>> = {
  AT: group("AT/en", "Europe/Vienna"),
  BE: group("BE/en", "Europe/Brussels"),
  CH: group("GROUP/en", "Europe/Zurich", "gls-group.eu"),
  CZ: group("CZ/en", "Europe/Prague"),
  DK: group("DK/en", "Europe/Copenhagen"),
  FI: group("FI/en", "Europe/Helsinki"),
  FR: group("FR/en", "Europe/Paris"),
  HR: group("HR/en", "Europe/Zagreb"),
  HU: group("HU/en", "Europe/Budapest"),
  IE: group("IE/en", "Europe/Dublin"),
  IT: group("IT/en", "Europe/Rome", "gls-group.com", "NAT"),
  LI: group("LI/en", "Europe/Vaduz"),
  LU: group("LU/en", "Europe/Luxembourg"),
  RO: group("RO/en", "Europe/Bucharest"),
  RS: group("RS/en", "Europe/Belgrade", "gls-group.eu"),
  SI: group("SI/en", "Europe/Ljubljana"),
  SK: group("SK/sk", "Europe/Bratislava"),
};

export const COUNTRIES = ["NL", ...Object.keys(GROUP_COUNTRIES)] as const;

/** Narrowing helpers for untrusted JSON. */
export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO 8601 for a timestamp string that carries its own offset; null when it does not parse. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Offset of `timeZone` from UTC, in minutes, at the given instant. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((local - at) / 60_000);
}

/** A wall-clock date (`YYYY-MM-DD` or `YY-MM-DD`) and time in `timeZone`, as ISO 8601 UTC. */
export function localTime(date: unknown, time: unknown, timeZone: string): string | null {
  const day = typeof date === "string" ? /^(\d{2}|\d{4})-(\d{2})-(\d{2})$/.exec(date.trim()) : null;
  const clock =
    typeof time === "string" ? /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim()) : null;
  if (day === null || clock === null) {
    return null;
  }
  const year = Number(day[1]) + (day[1]?.length === 2 ? 2000 : 0);
  const naive = Date.UTC(
    year,
    Number(day[2]) - 1,
    Number(day[3]),
    Number(clock[1]),
    Number(clock[2]),
    Number(clock[3] ?? "0"),
  );
  if (Number.isNaN(naive)) {
    return null;
  }
  // Two passes settle the offset around a daylight saving change.
  const first = naive - offsetMinutes(naive, timeZone) * 60_000;
  return new Date(naive - offsetMinutes(first, timeZone) * 60_000).toISOString();
}

/** Maps a GLS status code or text through the shared status table. */
export function mapGls(
  code: string | null,
  description: string | null = null,
): MappedStatus | null {
  if (code === null && description === null) {
    return null;
  }
  return mapStatus(loadRules(), CARRIER_ID, {
    ...(code === null ? {} : { code }),
    ...(description === null ? {} : { text: description }),
  });
}

export function publicUrl(barcode: string): string {
  return (
    trackingUrl(loadRules(), CARRIER_ID, barcode) ??
    `https://gls-group.com/EU/en/parcel-tracking?match=${encodeURIComponent(barcode)}`
  );
}

/** History newest first, capped. */
export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, HISTORY_LIMIT);
}

/** Postcodes are sent without spaces. */
export function compactPostcode(postcode: string): string {
  return postcode.replace(/\s+/g, "");
}
