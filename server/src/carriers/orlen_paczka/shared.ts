import { rulesStatus, text as kitText, zonedIso, type ParcelStatus } from "../../plugin/api.js";

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

/**
 * Maps an event code through the shared table. Code 690 covers both "ready for collection" and
 * "handed to a carrier abroad"; only the label tells them apart (the table reads it with the
 * code), and an unrecognised label stays unmapped.
 */
export function mapCode(eventCode: string | null, label: string | null): ParcelStatus | null {
  if (eventCode === null) {
    return null;
  }
  const mapped = rulesStatus(CARRIER_ID, {
    code: eventCode,
    text: label?.toLowerCase() ?? "",
    fields: { event: eventCode },
  });
  return mapped?.status ?? null;
}
