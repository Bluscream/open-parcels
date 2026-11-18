/** Small helpers for reading untyped carrier JSON without casts. */

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function asObjects(value: unknown): Json[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Json[] = [];
  for (const item of value as unknown[]) {
    const object = asObject(item);
    if (object !== null) {
      result.push(object);
    }
  }
  return result;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parses JSON the carrier sent; `null` when the body is not JSON at all. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the HTML entities DHL puts into names and status texts. */
export function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Status text without markup and with collapsed whitespace. */
export function plainText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
