export const CARRIER_ID = "nova_post";
export const TRACKING_HOST = "api.novaposhta.ua";
export const HISTORY_LIMIT = 20;

export function publicUrl(barcode: string): string {
  return `https://novaposhta.ua/tracking/${encodeURIComponent(barcode)}`;
}

/** The carrier's own catch-all: known, but deliberately left unmapped. */
export const UNDETERMINED_CODE = "999";
