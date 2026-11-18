import { cleanText, walkHtml } from "../../plugin/api.js";

/** A table cell with its tag, so header (`th`) and data (`td`) cells can be told apart. */
export interface Cell {
  readonly header: boolean;
  readonly text: string;
}

export interface Page {
  readonly tables: Cell[][][];
  readonly paragraphs: string[];
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
    scan.row.push({ header: scan.cell.header, text: cleanText(scan.cell.parts.join("")) });
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
    scan.page.paragraphs.push(cleanText(scan.paragraph.join("")));
    scan.paragraph = null;
  }
}

/**
 * Reads every table row by row, header cells marked, nested tables allowed, and every paragraph's
 * text. Scripts, styles and comments are dropped.
 */
export function readPage(html: string): Page {
  const scan: Scan = {
    page: { tables: [], paragraphs: [] },
    depth: 0,
    row: null,
    cell: null,
    paragraph: null,
  };
  walkHtml(html, {
    start: (tag) => {
      openTag(scan, tag);
    },
    end: (tag) => {
      closeTag(scan, tag);
    },
    data: (data) => {
      addText(scan, data);
    },
  });
  closeRow(scan);
  return scan.page;
}
