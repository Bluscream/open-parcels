/** Small text helpers for reading Amazon's HTML without a DOM. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities Amazon uses in attributes and text. Unknown names stay as they are. */
export function unescapeHtml(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return safeCodePoint(Number.parseInt(name.slice(2), 16)) ?? whole;
    }
    if (name.startsWith("#")) {
      return safeCodePoint(Number.parseInt(name.slice(1), 10)) ?? whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function safeCodePoint(value: number): string | undefined {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : undefined;
}

/** Decoded text with runs of whitespace collapsed. */
export function cleanText(raw: string): string {
  return unescapeHtml(raw).replace(/\s+/g, " ").trim();
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
