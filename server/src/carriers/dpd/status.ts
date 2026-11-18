import { loadRules, mapStatus, trackingUrl, type MappedStatus } from "open-parcels-rules";
import type { ParcelSnapshot } from "../../plugin/api.js";

export type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/** DPD's codes and texts as canonical statuses, from the shared rules' DPD table. */
export function mapDpd(raw: { code?: string; text?: string }): MappedStatus | null {
  return mapStatus(loadRules(), "dpd", raw);
}

export function textStatus(text: string): ParcelStatus | null {
  return text.trim() === "" ? null : (mapDpd({ text })?.status ?? null);
}

/*
 * Local tables for values the shared rules do not list yet. They belong in the rules' DPD table;
 * keep them here only until they have moved.
 */

/** Steps of the public tracking page (`statusInfo[].status`). */
const TRACKING_STEPS: Readonly<Record<string, ParcelStatus>> = {
  ACCEPTED: "registered",
  AT_SENDING_DEPOT: "in_transit",
  ON_THE_ROAD: "in_transit",
  AT_DELIVERY_DEPOT: "in_transit",
  OUT_FOR_DELIVERY: "out_for_delivery",
  PICKUP: "at_pickup_point",
  DELIVERED: "delivered",
};

/** A public tracking step: the local table first, then the shared codes. */
export function trackingStepStatus(code: string): ParcelStatus | null {
  return TRACKING_STEPS[code] ?? mapDpd({ code })?.status ?? null;
}

/**
 * `images/status_<N>.svg` on the account's parcel list is a DPD-internal code, not a slot index.
 * Observed values only; the return icon (3) is recognised through the return wording instead.
 */
const ICONS: Readonly<Record<number, ParcelStatus>> = { 6: "delivered" };

export function iconStatus(icon: number | null): ParcelStatus | null {
  return icon === null ? null : (ICONS[icon] ?? null);
}

/** Icons already seen together with a status, so new pairs are reported once. */
export const KNOWN_ICON_PAIRS = new Set(["6:delivered", "3:returning"]);

/** Milestone texts already seen on the account, so new wordings are reported once. */
export const KNOWN_SLOT_TEXTS = new Set(
  [
    "Paketinfo an DPD übergeben",
    "Paket unterwegs",
    "Paket im Paketzustellzentrum",
    "Paket in Zustellung",
    "Paket zugestellt",
    "Retoure Paket an DPD übergeben",
    "Retoure unterwegs",
    "Retoure an Versender",
  ].map((text) => text.toLowerCase()),
);

/** The public page for one parcel, from the shared carrier registry when it lists one. */
export function publicUrl(barcode: string): string {
  return (
    trackingUrl(loadRules(), "dpd", barcode, "de") ??
    `https://tracking.dpd.de/status/de_DE/parcel/${encodeURIComponent(barcode)}`
  );
}
