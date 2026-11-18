import type { SnapshotEvent } from "../../plugin/api.js";

type ParcelStatus = NonNullable<SnapshotEvent["status"]>;

export const CARRIER_ID = "orlen_paczka";
export const TRACKING_HOST = "nadaj.orlenpaczka.pl";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
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

/** Event codes arrive as strings or numbers. */
export function code(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
}

const WARSAW = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Minutes Warsaw is ahead of UTC at `instant`. */
function warsawOffsetMinutes(instant: number): number {
  const parts = Object.fromEntries(
    WARSAW.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const local = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
  );
  return Math.round((local - instant) / 60_000);
}

/** Parses ORLEN's `DD-MM-YYYY, HH:MM` (Warsaw local time) to ISO 8601 UTC; null otherwise. */
export function isoTime(value: unknown): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4}), (\d{2}):(\d{2})$/.exec(text(value) ?? "");
  if (match === null) {
    return null;
  }
  const [, day, month, year, hour, minute] = match.map(Number);
  if ([day, month, year, hour, minute].some((part) => part === undefined)) {
    return null;
  }
  const asUtc = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  // Two passes settle the offset across a daylight-saving change.
  let instant = asUtc - warsawOffsetMinutes(asUtc) * 60_000;
  instant = asUtc - warsawOffsetMinutes(instant) * 60_000;
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** ORLEN event codes. Kept local until the shared rules carry an ORLEN table. */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  "100": "in_transit",
  "200": "registered",
  "210": "registered",
  "240": "in_transit",
  "300": "in_transit",
  "653": "in_transit",
  "680": "out_for_delivery",
  "1000": "delivered",
};

const PICKUP_LABEL = "czeka na odbiór w punkcie";
const HANDOFF_LABELS = ["paczka w innym kraju", "przekazana do przewoźnika w innym kraju"];

/**
 * Maps an event code. Code 690 covers both "ready for collection" and "handed to a carrier
 * abroad"; only the label tells them apart, and an unrecognised label stays unmapped.
 */
export function mapCode(eventCode: string | null, label: string | null): ParcelStatus | null {
  if (eventCode === null) {
    return null;
  }
  if (eventCode !== "690") {
    return STATUS_MAP[eventCode] ?? null;
  }
  const lower = label?.toLowerCase() ?? "";
  if (lower.includes(PICKUP_LABEL)) {
    return "at_pickup_point";
  }
  return HANDOFF_LABELS.some((handoff) => lower.includes(handoff)) ? "in_transit" : null;
}
