import { cleanText, unescapeHtml, UnexpectedResponseError } from "../../plugin/api.js";

/**
 * A strict reader for the Colis Privé result page. It fails closed: anything it cannot
 * positively identify throws instead of yielding a partial parcel. The block with the
 * recipient's name and address is cut out before anything else is read.
 */

const PANEL_ID = "ctl00_CDC_pnResultatColis";
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;

export interface Row {
  readonly date: string;
  readonly text: string;
}

export interface ResultPage {
  readonly sender: string | null;
  readonly statusText: string;
  /** Newest first, as on the page. */
  readonly rows: readonly Row[];
}

/** Visible text of a fragment, whitespace collapsed. Tags vanish without a gap; `<br>` is a space. */
export function textOf(fragment: string): string {
  return cleanText(unescapeHtml(fragment.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")));
}

/** Where the element opened at `start` ends (after its closing tag), counting nested same tags. */
function elementEnd(html: string, start: number, tag: string): number {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) {
      return match.index + match[0].length;
    }
  }
  return html.length;
}

/** Removes every element whose class list contains `className`. */
function cutByClass(html: string, className: string): string {
  const opening = new RegExp(`<(\\w+)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "i");
  let rest = html;
  for (let match = opening.exec(rest); match !== null; match = opening.exec(rest)) {
    const end = elementEnd(rest, match.index, match[1] ?? "div");
    rest = rest.slice(0, match.index) + rest.slice(end);
  }
  return rest;
}

function firstElementText(html: string, opening: RegExp): string | null {
  const match = opening.exec(html);
  if (match === null) {
    return null;
  }
  const tag = match[1] ?? "div";
  const end = elementEnd(html, match.index, tag);
  const inner = html
    .slice(match.index + match[0].length, end)
    .replace(new RegExp(`</${tag}>$`, "i"), "");
  const text = textOf(inner);
  return text === "" ? null : text;
}

export function parseResultPage(page: string): ResultPage {
  const panelStart = page.search(new RegExp(`id="${PANEL_ID}"`));
  if (panelStart < 0) {
    throw new UnexpectedResponseError("Colis Privé page has no result panel.");
  }
  const panel = cutByClass(page.slice(panelStart), "divDesti");
  const sender = firstElementText(panel, /<h1\b[^>]*>\s*<(span)\b[^>]*>/i);
  const statusFrom = panel.search(/class="[^"]*\bdivStatut\b/);
  const statusText =
    statusFrom < 0
      ? null
      : firstElementText(
          panel.slice(statusFrom),
          /<(\w+)\b[^>]*class="[^"]*\btdText\b[^"]*"[^>]*>/i,
        );
  if (statusText === null) {
    throw new UnexpectedResponseError("Colis Privé page has no status cell.");
  }
  if (!panel.includes('id="th-date"') || !panel.includes('id="th-statut"')) {
    throw new UnexpectedResponseError("Colis Privé page has no history header.");
  }
  const rows: Row[] = [];
  for (const match of panel.matchAll(
    /<tr\b[^>]*class="[^"]*\bbandeauText\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
  )) {
    const cells = match[1] ?? "";
    const date = textOf(
      /<td\b[^>]*headers="th-date"[^>]*>([\s\S]*?)<\/td>/i.exec(cells)?.[1] ?? "",
    );
    const text = textOf(
      /<td\b[^>]*headers="th-statut"[^>]*>([\s\S]*?)<\/td>/i.exec(cells)?.[1] ?? "",
    );
    if (!DATE.test(date) || text === "") {
      throw new UnexpectedResponseError("Colis Privé page has a malformed history row.");
    }
    rows.push({ date, text });
  }
  return { sender, statusText, rows };
}
