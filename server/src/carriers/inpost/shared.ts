import {
  isoTime as kitIsoTime,
  rulesStatus,
  text as anyText,
  type ParcelStatus,
} from "../../plugin/api.js";

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

/** InPost text fields are strings; numbers are never read as text. */
export const text = (value: unknown): string | null => anyText(value, { numbers: false });

/** ISO 8601 for a string or epoch-millisecond timestamp; null when it does not parse. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "runtime", epoch: "ms" });
/**
 * The shared table's InPost vocabularies: the Polish account inbox (`inbox`, its coarse
 * `inbox-group`), the Italian inbox (`group`) and the public cross-border codes (`tracking`).
 */
export type Vocabulary = "inbox" | "inbox-group" | "group" | "tracking";

/**
 * Looks a code up case-insensitively in one vocabulary; `report` receives codes it does not
 * know. Codes known to say nothing about the parcel (payment events) give null unreported.
 */
export function lookUpCode(
  vocabulary: Vocabulary,
  code: string | null,
  report?: (code: string) => void,
): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const mapped = rulesStatus(CARRIER_ID, { code: `${vocabulary}:${code.toLowerCase()}` });
  if (mapped === null) {
    report?.(code);
    return null;
  }
  return mapped.status === "unknown" ? null : mapped.status;
}
