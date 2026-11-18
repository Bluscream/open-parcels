import { text as kitText, zonedIso, type ParcelStatus } from "../../plugin/api.js";

export const CARRIER_ID = "orlen_paczka";
export const TRACKING_HOST = "nadaj.orlenpaczka.pl";

export { asObject, isObject, type Json } from "../../plugin/api.js";

/** ORLEN's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Event codes arrive as strings or numbers. */
export function code(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
}

/** Parses ORLEN's `DD-MM-YYYY, HH:MM` (Warsaw local time) to ISO 8601 UTC; null otherwise. */
export function isoTime(value: unknown): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4}), (\d{2}):(\d{2})$/.exec(text(value) ?? "");
  if (match === null) {
    return null;
  }
  const [day, month, year, hour, minute] = match.slice(1).map(Number);
  return zonedIso(
    { year: year ?? 0, month: month ?? 0, day: day ?? 0, hour: hour ?? 0, minute: minute ?? 0 },
    "Europe/Warsaw",
  );
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
