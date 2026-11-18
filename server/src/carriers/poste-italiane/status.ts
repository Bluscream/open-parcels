import type { ParcelSnapshot } from "../../plugin/api.js";
import { fold } from "../../plugin/parse.js";

export type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/*
 * Poste Italiane reports only Italian sentences, no codes. The shared rules have no table for
 * this carrier yet; these prefixes and sentences belong there and stay here until they move.
 * Matched on the start of the folded sentence, longest first, because dates and places follow.
 */
const PREFIXES: readonly (readonly [string, ParcelStatus])[] = [
  ["la spedizione è stata presa in carico", "registered"],
  ["da un nostro operatore", "registered"],
  ["a seguito di acquisto da poste.it", "registered"],
  ["disponibile per il ritiro", "at_pickup_point"],
  ["la spedizione è in transito", "in_transit"],
  ["completata la fase di verifica per lo svincolo", "in_transit"],
  ["consegna non andata a buon fine", "problem"],
  ["sono in corso delle verifiche sulla spedizione", "problem"],
  ["in restituzione al mittente", "returning"],
  ["la spedizione è in consegna", "out_for_delivery"],
  ["la spedizione è stata consegnata", "delivered"],
];

/** Short fragments Poste sends as a whole event text. */
const EXACT: Readonly<Record<string, ParcelStatus>> = {
  "all'estero": "in_transit",
  "presso il paese estero in data": "in_transit",
  "in data": "in_transit",
  "con successo in data": "delivered",
};

/** Poste sometimes writes "è" as "e'"; both spellings are the same sentence. */
export function normalise(sentence: string): string {
  return fold(sentence).replace(/\be'(?=\s)/g, "è");
}

export function sentenceStatus(sentence: string | null): ParcelStatus | null {
  if (sentence === null) {
    return null;
  }
  const folded = normalise(sentence);
  return EXACT[folded] ?? PREFIXES.find(([prefix]) => folded.startsWith(prefix))?.[1] ?? null;
}

/** Wording that puts the parcel at a place the recipient collects it from. */
export function isPickupSentence(sentence: string | null): boolean {
  if (sentence === null) {
    return false;
  }
  const folded = normalise(sentence);
  return [
    "disponibile per il ritiro",
    "la spedizione è stata presa in carico presso il punto poste",
    "da un nostro operatore presso l'ufficio postale",
  ].some((prefix) => folded.startsWith(prefix));
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
