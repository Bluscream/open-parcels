import { rulesTrackingUrl } from "../../plugin/api.js";

export const CARRIER_ID = "nova_post";
export const TRACKING_HOST = "api.novaposhta.ua";
export const HISTORY_LIMIT = 20;

export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl(CARRIER_ID, barcode);
}

/** The carrier's own catch-all: known, but deliberately left unmapped. */
export const UNDETERMINED_CODE = "999";
