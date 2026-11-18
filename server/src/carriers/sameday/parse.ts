import type { ParcelStatus } from "../../domain/parcel.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "sameday";
export const COUNTRIES = ["ro", "hu", "bg"] as const;
export type Country = (typeof COUNTRIES)[number];

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The numeric `statusStateId` of an AWB event. Returns, cancellations and failures map to the
 * nearest canonical value; postponements and redirects are still in transit.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  "1": "registered",
  "2": "in_transit",
  "3": "in_transit",
  "4": "out_for_delivery",
  "5": "delivered",
  "6": "problem",
  "7": "in_transit",
  "8": "returning",
  "9": "in_transit",
  "10": "problem",
  "11": "problem",
  "12": "in_transit",
  "13": "returning",
  "14": "returning",
  "15": "returning",
  "16": "problem",
  "17": "in_transit",
  "18": "at_pickup_point",
  "19": "in_transit",
  "20": "at_pickup_point",
  "21": "in_transit",
  "22": "problem",
  "23": "problem",
  "24": "in_transit",
  "25": "in_transit",
  "26": "in_transit",
  "27": "in_transit",
  "29": "problem",
  "30": "problem",
};

export function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS_MAP[code] ?? null);
}

const PUBLIC_PAGES: Readonly<Record<Country, string>> = {
  ro: "https://sameday.ro/status-colet/?awb=",
  hu: "https://sameday.hu/#awb=",
  bg: "https://sameday.bg/status-na-pratkata/?awb=",
};

interface Entry {
  readonly at: string;
  readonly code: string | null;
  readonly raw: Json;
}

function entries(raw: Json): Entry[] {
  const list = Array.isArray(raw["awbHistory"]) ? (raw["awbHistory"] as unknown[]) : [];
  const result: Entry[] = [];
  for (const item of list) {
    const event = asObject(item);
    const at = isoTime(event["statusDate"]);
    if (at !== null) {
      result.push({ at, code: text(event["statusStateId"]), raw: event });
    }
  }
  return result.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function location(event: Json): string | null {
  return text(event["transitLocation"]) ?? text(event["county"]) ?? text(event["country"]);
}

/** Turns one AWB history into a snapshot; `report` receives unmapped status ids. */
export function awbSnapshot(
  raw: Json,
  barcode: string,
  country: Country,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = entries(raw);
  const latest = events[0];
  const code = latest?.code ?? null;
  const status = mapCode(code);
  if (code !== null && status === null) {
    report(code);
  }
  const history: SnapshotEvent[] = events.map((event) => ({
    at: event.at,
    status: mapCode(event.code),
    rawStatus: text(event.raw["statusState"]) ?? event.code ?? "?",
    location: location(event.raw),
  }));
  const atPoint = status === "at_pickup_point";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest === undefined ? null : (text(latest.raw["statusState"]) ?? code),
    deliveredAt: status === "delivered" ? (latest?.at ?? null) : null,
    pickup: atPoint,
    pickupPoint: atPoint && latest !== undefined ? location(latest.raw) : null,
    url: `${PUBLIC_PAGES[country]}${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
