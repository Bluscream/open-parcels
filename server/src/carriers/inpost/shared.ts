import {
  isoTime as kitIsoTime,
  lookUpStatus,
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
/** Looks a code up case-insensitively; `report` receives codes the table does not know. */
export function lookUpCode(
  table: Readonly<Record<string, ParcelStatus>>,
  code: string | null,
  report: (code: string) => void,
  ignored: ReadonlySet<string> = new Set(),
): ParcelStatus | null {
  return lookUpStatus(table, code?.toLowerCase() ?? null, (key) => {
    if (!ignored.has(key)) {
      report(code ?? key);
    }
  });
}
