import { walkHtml } from "../../plugin/api.js";

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
