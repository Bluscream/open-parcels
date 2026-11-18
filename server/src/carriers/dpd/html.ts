import { textOf, unescapeHtml } from "../../plugin/api.js";

/**
 * A small, dependency-free reader for the server-rendered myDPD pages. Everything is looked up by
 * element id, never by position or layout, so cosmetic changes to the pages do not break it.
 */

const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const OPENING_TAG = /<([A-Za-z][\w:-]*)\b([^>]*)>/g;
const INPUT = /<input\b([^>]*)>/gi;
const VOID_TAGS = new Set(["input", "img", "br", "hr", "meta", "link"]);

/** Attributes of one tag, lower-cased names and unescaped values. */
export function attributes(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined) {
      result.set(name, unescapeHtml(match[2] ?? match[3] ?? ""));
    }
  }
  return result;
}

export interface Control {
  readonly attrs: ReadonlyMap<string, string>;
  readonly text: string;
}

/** A fetched page, indexed by element id. The first element with an id wins. */
export class Page {
  readonly #controls = new Map<string, Control>();

  constructor(readonly html: string) {
    const lowered = html.toLowerCase();
    for (const match of html.matchAll(OPENING_TAG)) {
      const attrs = attributes(match[2] ?? "");
      const id = attrs.get("id");
      const tag = (match[1] ?? "").toLowerCase();
      if (id === undefined || id === "" || this.#controls.has(id)) {
        continue;
      }
      const start = match.index + match[0].length;
      const end = VOID_TAGS.has(tag) ? -1 : lowered.indexOf(`</${tag}`, start);
      this.#controls.set(id, { attrs, text: end === -1 ? "" : textOf(html.slice(start, end)) });
    }
  }

  get ids(): string[] {
    return [...this.#controls.keys()];
  }

  control(id: string): Control | undefined {
    return this.#controls.get(id);
  }

  text(id: string): string | undefined {
    return this.#controls.get(id)?.text;
  }

  value(id: string): string | undefined {
    const control = this.#controls.get(id);
    return control === undefined ? undefined : (control.attrs.get("value") ?? "");
  }
}

const SKIPPED_INPUT_TYPES = new Set(["submit", "button", "image", "checkbox", "radio", "password"]);

/**
 * Every input of a page, to be echoed back by the next postback. Returns null when the page lacks
 * the form state every postback needs.
 */
export function formFields(html: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(INPUT)) {
    const attrs = attributes(match[1] ?? "");
    const name = attrs.get("name");
    const type = (attrs.get("type") ?? "text").toLowerCase();
    if (name === undefined || name === "" || SKIPPED_INPUT_TYPES.has(type)) {
      continue;
    }
    fields.set(name, attrs.get("value") ?? "");
  }
  return fields.has("__VIEWSTATE") && fields.has("__EVENTVALIDATION") ? fields : null;
}

/** Values of every `<input>` with this name. */
export function inputValues(html: string, name: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(INPUT)) {
    const attrs = attributes(match[1] ?? "");
    if (attrs.get("name") === name) {
      values.push((attrs.get("value") ?? "").replace(/\s+/g, " ").trim());
    }
  }
  return values;
}
