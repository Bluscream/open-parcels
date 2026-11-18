/**
 * Small, dependency-free readers for server-rendered carrier pages: entity decoding, tag-free
 * text, attributes, a tokenizer and a table reader.
 */
import { UnexpectedResponseError } from "../errors.js";

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  ntilde: "ñ",
  Ntilde: "Ñ",
  ccedil: "ç",
  Ccedil: "Ç",
  ordf: "ª",
  ordm: "º",
};

function codePoint(value: number): string | undefined {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : undefined;
}

/** Decodes numeric and common named entities. Unknown names and invalid numbers stay as they are. */
export function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return codePoint(Number.parseInt(name.slice(2), 16)) ?? whole;
    }
    if (name.startsWith("#")) {
      return codePoint(Number.parseInt(name.slice(1), 10)) ?? whole;
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Collapses whitespace, non-breaking spaces included, and trims. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Tag-free, unescaped, whitespace-collapsed text of an HTML fragment. */
export function textOf(fragment: string): string {
  return cleanText(unescapeHtml(fragment.replace(/<[^>]*>/g, " ")));
}

/** Attributes of one tag: lower-cased names, unescaped values; the first of a name wins. */
export function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && !result.has(name)) {
      result.set(name, unescapeHtml(match[2] ?? match[3] ?? match[4] ?? ""));
    }
  }
  return result;
}

export interface HtmlHandler {
  start(tag: string, attrs: Map<string, string>): void;
  end(tag: string): void;
  data(text: string): void;
}

const VOID_TAGS = new Set(["input", "img", "br", "hr", "meta", "link", "source", "wbr"]);
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** Feeds tags and decoded text to the handler, skipping comments, scripts and styles. */
export function walkHtml(html: string, handler: HtmlHandler): void {
  const token = /<!--[\s\S]*?-->|<!\w[^>]*>|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)|</g;
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    const [whole, closing, rawTag, rest, data] = match;
    if (data !== undefined) {
      handler.data(unescapeHtml(data));
      continue;
    }
    if (rawTag === undefined) {
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing === "/") {
      handler.end(tag);
      continue;
    }
    if (RAW_TEXT_TAGS.has(tag)) {
      // Skip the script or style body entirely; its text is never read.
      const close = html.toLowerCase().indexOf(`</${tag}`, token.lastIndex);
      token.lastIndex = close === -1 ? html.length : close;
      continue;
    }
    handler.start(tag, attributes(rest ?? ""));
    if (VOID_TAGS.has(tag) || whole.endsWith("/>")) {
      handler.end(tag);
    }
  }
}

/** One table on a page: its classes, id, the last `h3` before it, and its rows of cell text. */
export interface HtmlTable {
  readonly classes: ReadonlySet<string>;
  readonly id: string | null;
  readonly heading: string;
  readonly rows: string[][];
}

export interface HtmlTables {
  readonly tables: readonly HtmlTable[];
  /** All visible text, whitespace collapsed. */
  readonly text: string;
}

/** Mutable state of the scan; kept in one object so each step stays small. */
interface Scan {
  readonly carrier: string;
  heading: string;
  headingParts: string[] | null;
  table: HtmlTable | null;
  row: string[] | null;
  cell: string[] | null;
  readonly tables: HtmlTable[];
  readonly text: string[];
}

function closeCell(scan: Scan): void {
  if (scan.cell !== null && scan.row !== null) {
    scan.row.push(cleanText(scan.cell.join("")));
  }
  scan.cell = null;
}

function closeRow(scan: Scan): void {
  closeCell(scan);
  if (scan.row !== null && scan.table !== null) {
    scan.table.rows.push(scan.row);
  }
  scan.row = null;
}

function addText(scan: Scan, value: string): void {
  scan.text.push(value);
  scan.cell?.push(value);
  scan.headingParts?.push(value);
}

function openTag(scan: Scan, tag: string, attrs: Map<string, string>): void {
  if (tag === "table") {
    if (scan.table !== null) {
      throw new UnexpectedResponseError(`${scan.carrier} page has a nested table.`);
    }
    const classes = new Set((attrs.get("class") ?? "").split(/\s+/));
    scan.table = { classes, id: attrs.get("id") ?? null, heading: scan.heading, rows: [] };
    scan.tables.push(scan.table);
  } else if (tag === "tr" && scan.table !== null) {
    closeRow(scan);
    scan.row = [];
  } else if ((tag === "td" || tag === "th") && scan.row !== null) {
    closeCell(scan);
    scan.cell = [];
  } else if (tag === "h3") {
    scan.headingParts = [];
  } else if (tag === "br") {
    addText(scan, " ");
  }
}

function closeTag(scan: Scan, tag: string): void {
  if (tag === "td" || tag === "th") {
    closeCell(scan);
  } else if (tag === "tr") {
    closeRow(scan);
  } else if (tag === "table" && scan.table !== null) {
    closeRow(scan);
    scan.table = null;
  } else if (tag === "h3" && scan.headingParts !== null) {
    scan.heading = cleanText(scan.headingParts.join("")).toLowerCase();
    scan.headingParts = null;
  }
}

/**
 * Collects every table (rows of cell text) and the visible text of a page. Scripts, styles and
 * comments are skipped. A nested table is an unexpected response naming `carrier`.
 */
export function readTables(html: string, carrier: string): HtmlTables {
  const scan: Scan = {
    carrier,
    heading: "",
    headingParts: null,
    table: null,
    row: null,
    cell: null,
    tables: [],
    text: [],
  };
  walkHtml(html, {
    start: (tag, attrs) => {
      openTag(scan, tag, attrs);
    },
    end: (tag) => {
      closeTag(scan, tag);
    },
    data: (data) => {
      addText(scan, data);
    },
  });
  closeRow(scan);
  return { tables: scan.tables, text: cleanText(scan.text.join(" ")) };
}
