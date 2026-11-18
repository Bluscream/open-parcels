import {
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";

export type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export const CARRIER_ID = "inpost";
export const TRACKING_HOST = "inposteasy.com";
export const INBOX_HOST = "api-inmobile-pl.easypack24.net";
export const SIGN_IN_HOST = "account.inpost-group.com";

/** Markets whose accounts can sign in; the market decides which inbox backend answers. */
export const MARKETS = ["PL", "IT"] as const;
export type Market = (typeof MARKETS)[number];

/** Countries with an InPost tracking page; the tracking API itself is shared by all of them. */
export const TRACKING_COUNTRIES = ["PL", "IT", "PT", "GB", "ES"] as const;
export type TrackingCountry = (typeof TRACKING_COUNTRIES)[number];

const TRACKING_PAGES: Readonly<Record<TrackingCountry, (code: string) => string>> = {
  PL: (code) => `https://inpost.pl/en/find-parcel?number=${code}`,
  IT: (code) => `https://inpost.it/trova-il-tuo-pacco?number=${code}`,
  PT: (code) => `https://www.inpost.pt/seguimento-do-envio/?exp=${code}&language=pt&pais=PT`,
  GB: (code) => `https://inpost.co.uk/tracking/result?parcel_code=${code}`,
  ES: (code) => `https://www.inpost.es/seguimiento-del-envio/?exp=${code}&language=ES`,
};

export function publicUrl(barcode: string, country: TrackingCountry): string {
  return TRACKING_PAGES[country](encodeURIComponent(barcode));
}

/** Narrowing helpers for untrusted JSON. */
export type Json = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO 8601 for a string or epoch-millisecond timestamp; null when it does not parse. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseBody(body: string, what: string): Json {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new UnexpectedResponseError(`${what} did not answer with JSON.`);
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`${what} did not answer with an object.`);
  }
  return payload;
}

/** History entries sorted newest first. */
export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Looks a code up case-insensitively; `report` receives codes the table does not know. */
export function lookUpCode(
  table: Readonly<Record<string, ParcelStatus>>,
  code: string | null,
  report: (code: string) => void,
  ignored: ReadonlySet<string> = new Set(),
): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const key = code.toLowerCase();
  const status = table[key] ?? null;
  if (status === null && !ignored.has(key)) {
    report(code);
  }
  return status;
}
