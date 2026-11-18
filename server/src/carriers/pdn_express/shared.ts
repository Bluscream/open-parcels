import type { SnapshotEvent } from "../../plugin/api.js";

type ParcelStatus = NonNullable<SnapshotEvent["status"]>;

export const CARRIER_ID = "pdn_express";
export const TRACKING_HOST = "pdn.express";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * PDN Express event codes. Not in the shared rules package yet, so kept here; mapping too little
 * beats mapping wrongly. D845 comes from the tracking page's stage list, not from a seen scan.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  D800: "registered",
  D830: "in_transit",
  D840: "out_for_delivery",
  D814: "problem",
  D850: "problem",
  D845: "at_pickup_point",
  D860: "delivered",
  D890: "returning",
};

/** Customer-service notes: they say nothing about where the parcel is and never set a status. */
const NOTE_CODES: ReadonlySet<string> = new Set(["D810"]);

/** The mapped status, null for notes and unknown codes; unknown codes go to `report`. */
export function mapCode(code: string | null, report: (code: string) => void): ParcelStatus | null {
  if (code === null || NOTE_CODES.has(code)) {
    return null;
  }
  const mapped = STATUS_MAP[code];
  if (mapped === undefined) {
    report(code);
    return null;
  }
  return mapped;
}

const OFFSET_PATTERN = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/;
const LOCAL_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * `eventTime` is a wall clock without offset; `utcTimezone` ("UTC+2") carries the offset and
 * already settles daylight saving. Null when either part does not parse.
 */
export function eventTime(event: Json): string | null {
  const local = LOCAL_PATTERN.exec(text(event["eventTime"]) ?? "");
  const offset = OFFSET_PATTERN.exec(text(event["utcTimezone"]) ?? "");
  if (local === null || offset === null) {
    return null;
  }
  const hours = (offset[2] ?? "0").padStart(2, "0");
  const minutes = offset[3] ?? "00";
  const parsed = new Date(`${local[1]}T${local[2]}${offset[1]}${hours}:${minutes}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function publicUrl(barcode: string): string {
  return `https://pdn.express/en/track/${encodeURIComponent(barcode)}`;
}

export function newestFirst(events: SnapshotEvent[]): SnapshotEvent[] {
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
