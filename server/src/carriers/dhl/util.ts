import { isObject, type Json } from "../../plugin/api.js";

/**
 * DHL-specific narrowing on top of the plug-in kit. DHL's payloads tell "no block" apart from an
 * empty one, so these return null where the kit's `asObject` and `text` would give `{}` or trim.
 */
export type { Json };

/** The value as an object, or null when it is not one. */
export function asObject(value: unknown): Json | null {
  return isObject(value) ? value : null;
}

/** A non-empty string exactly as sent (not trimmed), or null. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
