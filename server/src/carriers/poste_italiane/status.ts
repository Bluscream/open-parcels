import { cleanText, rulesStatus, type ParcelSnapshot } from "../../plugin/api.js";

/** Lower-cased, whitespace-collapsed text for matching the carrier's wording. */
const fold = (value: string): string => cleanText(value).toLowerCase();

export type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/*
 * Poste Italiane reports only Italian sentences, no codes. The shared table knows short
 * fragments sent as a whole event text, and longer sentences by their start, because dates and
 * places follow.
 */
const CARRIER_ID = "poste_italiane";

/** Poste sometimes writes "è" as "e'"; both spellings are the same sentence. */
export function normalise(sentence: string): string {
  return fold(sentence).replace(/\be'(?=\s)/g, "è");
}

export function sentenceStatus(sentence: string | null): ParcelStatus | null {
  if (sentence === null) {
    return null;
  }
  const folded = normalise(sentence);
  const mapped = rulesStatus(CARRIER_ID, { code: folded, text: folded, fields: { use: "status" } });
  return mapped?.status ?? null;
}

/** Wording that puts the parcel at a place the recipient collects it from. */
export function isPickupSentence(sentence: string | null): boolean {
  if (sentence === null) {
    return false;
  }
  const folded = normalise(sentence);
  return rulesStatus(CARRIER_ID, { text: folded, fields: { use: "pickup" } }) !== null;
}

const MONTHS = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
];

/** `Consegna prevista entro venerdì 20 novembre 2026` as a calendar day, or null. */
export function estimateDay(value: string | null): string | null {
  const match = /consegna prevista(?: entro)?\s+(?:\S+\s+)?(\d{1,2})\s+([a-zà]+)\s+(\d{4})/i.exec(
    value ?? "",
  );
  if (match === null) {
    return null;
  }
  const month = MONTHS.indexOf((match[2] ?? "").toLowerCase()) + 1;
  const day = Number(match[1]);
  const year = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (month === 0 || probe.getUTCDate() !== day) {
    return null;
  }
  return probe.toISOString().slice(0, 10);
}
