/** A table cell with its tag, so header (`th`) and data (`td`) cells can be told apart. */
export interface Cell {
  readonly header: boolean;
  readonly text: string;
}

export interface Page {
  readonly tables: Cell[][][];
  readonly paragraphs: string[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (/^#x/i.test(name)) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Collapses whitespace; `\s` covers the non-breaking space too. */
export function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface Scan {
  readonly page: Page;
  depth: number;
  row: Cell[] | null;
  cell: { header: boolean; parts: string[] } | null;
  paragraph: string[] | null;
}

function closeCell(scan: Scan): void {
  if (scan.cell !== null && scan.row !== null) {
    scan.row.push({ header: scan.cell.header, text: clean(scan.cell.parts.join("")) });
  }
  scan.cell = null;
}

function closeRow(scan: Scan): void {
  closeCell(scan);
  const table = scan.page.tables.at(-1);
  if (scan.row !== null && table !== undefined) {
    table.push(scan.row);
  }
  scan.row = null;
}

function addText(scan: Scan, value: string): void {
  scan.cell?.parts.push(value);
  scan.paragraph?.push(value);
}

function openTag(scan: Scan, tag: string): void {
  if (tag === "table") {
    scan.depth += 1;
    scan.page.tables.push([]);
  } else if (tag === "tr" && scan.depth > 0) {
    closeRow(scan);
    scan.row = [];
  } else if ((tag === "td" || tag === "th") && scan.row !== null) {
    closeCell(scan);
    scan.cell = { header: tag === "th", parts: [] };
  } else if (tag === "p") {
    scan.paragraph = [];
  } else if (tag === "br") {
    addText(scan, " ");
  }
}

function closeTag(scan: Scan, tag: string): void {
  if (tag === "td" || tag === "th") {
    closeCell(scan);
  } else if (tag === "tr") {
    closeRow(scan);
  } else if (tag === "table" && scan.depth > 0) {
    closeRow(scan);
    scan.depth -= 1;
  } else if (tag === "p" && scan.paragraph !== null) {
    scan.page.paragraphs.push(clean(scan.paragraph.join("")));
    scan.paragraph = null;
  }
}

const TOKEN = /<(\/?)([a-z0-9]+)\b[^>]*>|([^<]+)/gi;

/** Reads every table row by row, and every paragraph's text. Scripts and styles are dropped. */
export function readPage(html: string): Page {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const scan: Scan = {
    page: { tables: [], paragraphs: [] },
    depth: 0,
    row: null,
    cell: null,
    paragraph: null,
  };
  for (const [, slash, name, data] of stripped.matchAll(TOKEN)) {
    if (data !== undefined) {
      addText(scan, decode(data));
    } else if (name !== undefined) {
      if (slash === "/") {
        closeTag(scan, name.toLowerCase());
      } else {
        openTag(scan, name.toLowerCase());
      }
    }
  }
  closeRow(scan);
  return scan.page;
}
