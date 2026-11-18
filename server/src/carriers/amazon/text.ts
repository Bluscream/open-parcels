import { cleanText as collapse, unescapeHtml } from "../../plugin/api.js";

/** Small text helpers for reading Amazon's HTML without a DOM. */

export { unescapeHtml };

/** Decoded text with runs of whitespace collapsed. */
export function cleanText(raw: string): string {
  return collapse(unescapeHtml(raw));
}

/** Hides digits, so a report key never carries a date, an amount or an id. */
export function maskDigits(text: string): string {
  return text.replace(/\d+/g, "#");
}

/** Lower-cased, typographic apostrophes folded, trailing full stops dropped. */
export function foldText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[.!]+$/, "");
}
