import type { ParcelSnapshot } from "../plugin/snapshot.js";

/**
 * A link as stored: only absolute `http` and `https` addresses. Anything else (`javascript:`,
 * `data:`, a relative path) is dropped, since links reach the web UI, Home Assistant attributes
 * and calendar feeds, not all of which guard against other schemes.
 */
export function safeUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** The snapshot with every link it carries checked. */
export function withSafeLinks(snapshot: ParcelSnapshot): ParcelSnapshot {
  return {
    ...snapshot,
    url: safeUrl(snapshot.url),
    items: snapshot.items.map((item) => ({
      ...item,
      url: safeUrl(item.url),
      imageUrl: safeUrl(item.imageUrl),
    })),
  };
}
