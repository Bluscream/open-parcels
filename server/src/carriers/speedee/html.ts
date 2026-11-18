import { UnexpectedResponseError } from "../../plugin/api.js";

/** One table on the page: its classes, the last `h3` before it, and its rows of cell text. */
export interface Table {
  readonly classes: ReadonlySet<string>;
  readonly heading: string;
  readonly rows: string[][];
}

export interface Page {
  readonly tables: readonly Table[];
  /** All visible text, whitespace collapsed. */
  readonly text: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

export function clean(value: string): string {
  // `\s` already covers the non-breaking space.
  return value.replace(/\s+/g, " ").trim();
}

const TOKEN = /<(\/?)([a-z0-9]+)\b([^>]*)>|([^<]+)/gi;

/** Mutable state of the scan; kept in one object so each step stays small. */
interface Scan {
  heading: string;
  headingParts: string[] | null;
  table: Table | null;
  row: string[] | null;
  cell: string[] | null;
  readonly tables: Table[];
  readonly text: string[];
}

function closeCell(scan: Scan): void {
  if (scan.cell !== null && scan.row !== null) {
    scan.row.push(clean(scan.cell.join("")));
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

function openTag(scan: Scan, tag: string, attributes: string): void {
  if (tag === "table") {
    if (scan.table !== null) {
      throw new UnexpectedResponseError("Spee-Dee page has a nested table.");
    }
    const classes = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? "";
    scan.table = { classes: new Set(classes.split(/\s+/)), heading: scan.heading, rows: [] };
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
    scan.heading = clean(scan.headingParts.join("")).toLowerCase();
    scan.headingParts = null;
  }
}

/** Collects every table and the visible text. Scripts, styles and comments are dropped first. */
export function readPage(html: string): Page {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const scan: Scan = {
    heading: "",
    headingParts: null,
    table: null,
    row: null,
    cell: null,
    tables: [],
    text: [],
  };
  for (const match of stripped.matchAll(TOKEN)) {
    const [, slash, name, attributes, data] = match;
    if (data !== undefined) {
      addText(scan, decode(data));
    } else if (name !== undefined) {
      const tag = name.toLowerCase();
      if (slash === "/") {
        closeTag(scan, tag);
      } else {
        openTag(scan, tag, attributes ?? "");
      }
    }
  }
  closeRow(scan);
  return { tables: scan.tables, text: clean(scan.text.join(" ")) };
}
