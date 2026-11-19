import {
  isoTime as kitIsoTime,
  rulesStatus,
  rulesTrackingUrl,
  text as anyText,
  type MappedStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "hermes";
export const TRACKING_HOST = "api.my-deliveries.de";
export const ACCOUNT_HOST = "mobile-app-api.a0930.prd.hc.de";

/** Hermes text fields are strings; numbers are never read as text. */
export const text = (value: unknown): string | null => anyText(value, { numbers: false });

/** ISO 8601 for a string or epoch-millisecond timestamp; null when it does not parse. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: { zone: "Europe/Berlin" }, epoch: "ms" });
/** Maps a Hermes status code (either vocabulary) through the shared status table. */
export function mapCode(
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
    rulesTrackingUrl(CARRIER_ID, barcode, "de") ??
    `https://www.myhermes.de/empfangen/sendungsverfolgung/#${encodeURIComponent(barcode)}`
  );
}
