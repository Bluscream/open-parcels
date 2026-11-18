import {
  rulesStatus,
  rulesTrackingUrl,
  type MappedStatus,
  type ParcelStatus,
} from "../../plugin/api.js";

export type { ParcelStatus };

/** DPD's codes and texts as canonical statuses, from the shared rules' DPD table. */
export function mapDpd(raw: { code?: string; text?: string }): MappedStatus | null {
  return rulesStatus("dpd", raw);
}

export function textStatus(text: string): ParcelStatus | null {
  return text.trim() === "" ? null : (mapDpd({ text })?.status ?? null);
}

/** A step of the public tracking page (`statusInfo[].status`, "step:"), then the plain codes. */
export function trackingStepStatus(code: string): ParcelStatus | null {
  return mapDpd({ code: `step:${code}` })?.status ?? mapDpd({ code })?.status ?? null;
}

/** `images/status_<N>.svg` on the account's parcel list: a DPD-internal code ("icon:<N>"). */
export function iconStatus(icon: number | null): ParcelStatus | null {
  return icon === null ? null : (mapDpd({ code: `icon:${String(icon)}` })?.status ?? null);
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
    rulesTrackingUrl("dpd", barcode, "de") ??
    `https://tracking.dpd.de/status/de_DE/parcel/${encodeURIComponent(barcode)}`
  );
}
