import { cleanText, unescapeHtml, UnexpectedResponseError } from "../../plugin/api.js";

/**
 * Reader for the tracking page, which has no structured alternative. It fails closed: anything it
 * cannot positively identify throws instead of yielding a partial parcel. Only the trace block is
 * read, and scan rows are picked by position inside their columns.
 */
const TITLE_FOUND = "Hrvatska Pošta - Tracking";
const TITLE_NO_DATA = "Hrvatska Pošta - Nema podataka";
const NO_DATA_NOTICE = "Nema podataka za uneseni prijamni broj pošiljke";
const BAD_FORMAT_NOTICE = "Neispravan format prijamnog broja pošiljke";
export const BOT_WALL_MARKERS = [
  "Request Rejected",
  "Access Denied",
  "Just a moment",
  "cf-turnstile",
];

const TRACE_CLASS = "track__n__trace";
const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "area",
  "base",
  "col",
  "wbr",
  "source",
]);
const LABEL_NUMBER = "Broj pošiljke";
const LABEL_WEIGHT = "Masa";

export interface ScanRow {
  date: string | null;
  time: string | null;
  wording: string | null;
  location: string | null;
}

export interface Page {
  readonly number: string;
  readonly weight: string | null;
  readonly rows: readonly ScanRow[];
}

interface Node {
  readonly tag: string;
  readonly classes: ReadonlySet<string>;
  parts: string[];
}

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;

function classesOf(attributes: string): Set<string> {
  const found = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(attributes);
  return new Set((found?.[1] ?? found?.[2] ?? found?.[3] ?? "").split(/\s+/).filter(Boolean));
}

/** Walks the page once, tracking the trace block, its header labels and its scan rows. */
class Walker {
  title = "";
  readonly visible: string[] = [];
  number: string | null = null;
  weight: string | null = null;
  readonly rows: ScanRow[] = [];
  hasTrace = false;
  readonly #stack: Node[] = [];
  #skip = 0;
  #inTitle = false;
  #traceDepth: number | null = null;
  #rowDepth: number | null = null;
  #row: ScanRow = { date: null, time: null, wording: null, location: null };
  #column: "date" | "what" | null = null;
  #columnDepth: number | null = null;
  #spans: string[] = [];
  #label: string | null = null;

  open(tag: string, classes: Set<string>): void {
    if (tag === "script" || tag === "style") {
      this.#skip += 1;
    }
    this.#inTitle ||= tag === "title";
    if (VOID_TAGS.has(tag)) {
      return;
    }
    this.#stack.push({ tag, classes, parts: [] });
    const depth = this.#stack.length;
    if (this.#traceDepth === null) {
      if (tag === "div" && classes.has(TRACE_CLASS)) {
        this.#traceDepth = depth;
        this.hasTrace = true;
      }
    } else if (this.#rowDepth === null) {
      if (tag === "div" && ["d-none", "d-md-flex", "row"].every((name) => classes.has(name))) {
        this.#rowDepth = depth;
        this.#row = { date: null, time: null, wording: null, location: null };
      }
    } else if (tag === "div" && this.#column === null) {
      this.#column = classes.has("col-lg-4") ? "date" : classes.has("col-lg-8") ? "what" : null;
      this.#columnDepth = this.#column === null ? null : depth;
      this.#spans = [];
    }
  }

  close(tag: string): void {
    if ((tag === "script" || tag === "style") && this.#skip > 0) {
      this.#skip -= 1;
    }
    if (tag === "title") {
      this.#inTitle = false;
    }
    const index = this.#stack.map((node) => node.tag).lastIndexOf(tag);
    if (VOID_TAGS.has(tag) || index < 0) {
      return;
    }
    const depth = index + 1;
    const node = this.#stack[index];
    this.#stack.length = index;
    if (node === undefined) {
      return;
    }
    if (this.#columnDepth === depth) {
      this.#finishColumn();
    } else if (
      this.#columnDepth !== null &&
      node.tag === "span" &&
      depth === this.#columnDepth + 1
    ) {
      this.#spans.push(cleanText(node.parts.join("")));
    }
    if (this.#rowDepth === depth) {
      this.rows.push(this.#row);
      this.#rowDepth = null;
    }
    if (this.#traceDepth === depth) {
      this.#traceDepth = null;
    }
    // A nested element's text belongs to its parent's text too.
    this.#stack.at(-1)?.parts.push(...node.parts);
  }

  data(raw: string): void {
    const value = unescapeHtml(raw);
    if (this.#inTitle) {
      this.title += value;
    }
    if (this.#skip > 0) {
      return;
    }
    this.#stack.at(-1)?.parts.push(value);
    this.visible.push(value);
    if (this.#traceDepth !== null && this.#rowDepth === null) {
      this.#header(cleanText(value));
    }
  }

  #finishColumn(): void {
    const first = this.#spans[0];
    if (this.#column === "date" && first !== undefined) {
      this.#row.date = /\b(\d{2}\.\d{2}\.\d{4})\b/.exec(first)?.[1] ?? null;
      this.#row.time = /\b(\d{2}:\d{2}:\d{2})\b/.exec(first)?.[1] ?? null;
    } else if (this.#column === "what") {
      this.#row.wording = first === undefined || first === "" ? null : first;
      const location = this.#spans[1];
      this.#row.location = location === undefined || location === "" ? null : location;
    }
    this.#column = null;
    this.#columnDepth = null;
    this.#spans = [];
  }

  #header(value: string): void {
    if (value === "") {
      return;
    }
    if (this.#label === LABEL_NUMBER) {
      this.number = value;
      this.#label = null;
    } else if (this.#label === LABEL_WEIGHT) {
      this.weight = value;
      this.#label = null;
    } else if (value === LABEL_NUMBER || value === LABEL_WEIGHT) {
      this.#label = value;
    }
  }
}

function walk(html: string): Walker {
  const walker = new Walker();
  // Script and style bodies are raw text that may hold markup-like strings.
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const token of markup.matchAll(TOKEN)) {
    const [whole, closing, tag, attributes, textPart] = token;
    if (textPart !== undefined) {
      walker.data(textPart);
    } else if (tag !== undefined && closing === "/") {
      walker.close(tag.toLowerCase());
    } else if (tag !== undefined) {
      walker.open(tag.toLowerCase(), classesOf(attributes ?? ""));
      if (whole.endsWith("/>")) {
        walker.close(tag.toLowerCase());
      }
    } else if (whole === "<") {
      walker.data("<");
    }
  }
  return walker;
}

/** The parsed page, or null for the carrier's "no data" notice. Throws on anything unexpected. */
export function parsePage(html: string, requested: string): Page | null {
  const page = walk(html);
  const title = cleanText(page.title);
  const visible = cleanText(page.visible.join(" "));
  const fail = (why: string): never => {
    throw new UnexpectedResponseError(
      `Hrvatska pošta's tracking page was not recognised (${why}).`,
    );
  };
  if (title === TITLE_NO_DATA) {
    if (visible.includes(NO_DATA_NOTICE) || visible.includes(BAD_FORMAT_NOTICE)) {
      return null;
    }
    return fail("no-data page without a known notice");
  }
  if (title !== TITLE_FOUND) {
    return fail("unexpected title");
  }
  if (!page.hasTrace) {
    return fail("no trace block");
  }
  if (page.number?.toUpperCase() !== requested) {
    return fail("shipment number missing or different");
  }
  if (page.rows.length === 0) {
    return fail("no scan rows");
  }
  return { number: requested, weight: page.weight, rows: page.rows };
}
