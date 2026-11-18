import { rulesStatus, type MappedStatus } from "../../plugin/api.js";

export const CARRIER_ID = "ppl_cz";
export const API_HOST = "api.dhl.com";
export const HISTORY_LIMIT = 20;

/**
 * A status code through the shared table. A dotted qualifier (`Delivered.Parcelshop`) only
 * narrows where or how; an unknown one falls back to its base code. A full entry still wins, which
 * keeps `Delivered.BackToSender` apart from `BackToSender`.
 */
export function mapPpl(code: string | null): MappedStatus | null {
  if (code === null) {
    return null;
  }
  const exact = rulesStatus(CARRIER_ID, { code });
  const base = code.split(".")[0] ?? code;
  return exact ?? (base === code ? null : rulesStatus(CARRIER_ID, { code: base }));
}

export function publicUrl(code: string): string {
  return `https://www.ppl.cz/vyhledat-zasilku?shipmentId=${encodeURIComponent(code)}`;
}
