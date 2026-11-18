/**
 * Pulls the `events` array out of a Next.js page's flight script chunks
 * (`self.__next_f.push([1, "…"])`). Returns null when no chunk carries a decodable array, and
 * undefined when the page has no flight chunks at all (the site changed shape).
 */

/** Index just past the JSON value that starts at `start`, or -1 when it does not close. */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

function eventsIn(text: string): Record<string, unknown>[] | null {
  const marker = '"events":';
  const at = text.indexOf(marker);
  if (at < 0) {
    return null;
  }
  const start = text.indexOf("[", at + marker.length);
  if (start < 0 || text.slice(at + marker.length, start).trim() !== "") {
    return null;
  }
  const end = valueEnd(text, start);
  if (end < 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text.slice(start, end));
    return Array.isArray(value) &&
      value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))
      ? (value as Record<string, unknown>[])
      : null;
  } catch {
    return null;
  }
}

function chunkStrings(script: string): string[] {
  const body = script.split("</script>", 1)[0] ?? "";
  const close = body.lastIndexOf(")");
  try {
    const pushed: unknown = JSON.parse(body.slice(0, close < 0 ? undefined : close).trim());
    return Array.isArray(pushed)
      ? pushed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function flightEvents(html: string): Record<string, unknown>[] | null | undefined {
  const scripts = html.split("self.__next_f.push(").slice(1);
  if (scripts.length === 0) {
    return undefined;
  }
  for (const script of scripts) {
    for (const text of chunkStrings(script)) {
      const events = eventsIn(text);
      if (events !== null) {
        return events;
      }
    }
  }
  return null;
}
