import {
  isoTime as kitIsoTime,
  newestFirst,
  rulesStatus,
  rulesTrackingUrl,
  text as anyText,
  zonedIso,
  type MappedStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

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

/** Countries with a national route of their own. */
export const NATIONAL_COUNTRIES = ["NL", "DE", "ES", "PT", "PL", "US", "CA"] as const;
export type NationalCountry = (typeof NATIONAL_COUNTRIES)[number];

export const COUNTRIES = [...NATIONAL_COUNTRIES, ...Object.keys(GROUP_COUNTRIES)] as const;

/** GLS sends text fields as strings only; numbers are never read as text. */
export const text = (value: unknown): string | null => anyText(value, { numbers: false });

/** ISO 8601 for a timestamp string that carries its own offset; null when it does not parse. */
export const isoTime = (value: unknown): string | null => kitIsoTime(value, { naive: "runtime" });

/** A wall-clock date (`YYYY-MM-DD` or `YY-MM-DD`) and time in `timeZone`, as ISO 8601 UTC. */
export function localTime(date: unknown, time: unknown, timeZone: string): string | null {
  const day = typeof date === "string" ? /^(\d{2}|\d{4})-(\d{2})-(\d{2})$/.exec(date.trim()) : null;
  const clock =
    typeof time === "string" ? /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim()) : null;
  if (day === null || clock === null) {
    return null;
  }
  return zonedIso(
    {
      year: Number(day[1]) + (day[1]?.length === 2 ? 2000 : 0),
      month: Number(day[2]),
      day: Number(day[3]),
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: Number(clock[3] ?? "0"),
    },
    timeZone,
  );
}

/** Maps a GLS status code or text through the shared status table. */
export function mapGls(
  code: string | null,
  description: string | null = null,
): MappedStatus | null {
  if (code === null && description === null) {
    return null;
  }
  return rulesStatus(CARRIER_ID, {
    ...(code === null ? {} : { code }),
    ...(description === null ? {} : { text: description }),
  });
}

export function publicUrl(barcode: string): string {
  return (
    rulesTrackingUrl(CARRIER_ID, barcode) ??
    `https://gls-group.com/EU/en/parcel-tracking?match=${encodeURIComponent(barcode)}`
  );
}

/** History newest first, capped. */
export function latestHistory(events: readonly SnapshotEvent[]): SnapshotEvent[] {
  return newestFirst(events).slice(0, HISTORY_LIMIT);
}

/** Postcodes are sent without spaces. */
export function compactPostcode(postcode: string): string {
  return postcode.replace(/\s+/g, "");
}
