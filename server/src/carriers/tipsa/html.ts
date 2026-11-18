/** A small, dependency-free HTML tokenizer for TIPSA's two server-rendered pages. */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
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
  uuml: "ü",
  Uuml: "Ü",
  ccedil: "ç",
  Ccedil: "Ç",
  ordf: "ª",
  ordm: "º",
};

export function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (/^#x/i.test(name)) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return ENTITIES[name] ?? whole;
  });
}

/** Collapses whitespace, non-breaking spaces included. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

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
const TOKEN = /<!--[\s\S]*?-->|<!\w[^>]*>|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)|</g;

/** Feeds tags and decoded text to the handler, skipping comments, scripts and styles. */
export function walkHtml(html: string, handler: HtmlHandler): void {
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(html); match !== null; match = TOKEN.exec(html)) {
    const [whole, closing, rawTag, rest, text] = match;
    if (text !== undefined) {
      handler.data(unescapeHtml(text));
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
      const close = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
      TOKEN.lastIndex = close === -1 ? html.length : close;
      continue;
    }
    handler.start(tag, attributes(rest ?? ""));
    if (VOID_TAGS.has(tag) || whole.endsWith("/>")) {
      handler.end(tag);
    }
  }
}

/** The target of the first `<meta http-equiv="refresh">`, if any. */
export function refreshTarget(html: string): string | null {
  let target: string | null = null;
  walkHtml(html, {
    start(tag, attrs) {
      if (
        target !== null ||
        tag !== "meta" ||
        attrs.get("http-equiv")?.toLowerCase() !== "refresh"
      ) {
        return;
      }
      const match = /url\s*=\s*(.+)$/i.exec(attrs.get("content") ?? "");
      target = match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
    },
    end: () => undefined,
    data: () => undefined,
  });
  return target;
}
