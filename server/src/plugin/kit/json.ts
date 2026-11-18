import { UnexpectedResponseError } from "../errors.js";
import type { HttpResponse } from "../http.js";

/** Narrowing helpers for untrusted JSON from carrier APIs. */
export type Json = Readonly<Record<string, unknown>>;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an object, or an empty one, so lookups on it are always safe. */
export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

/** The objects in a list; anything that is not a list gives an empty one. */
export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** A trimmed, non-empty string; numbers are accepted as their decimal text. */
export function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A finite number, from a number or a numeric string. */
export function num(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Parses a response body as JSON, tolerating a byte-order mark; a non-JSON body is unexpected. */
export function readJson(response: HttpResponse, what: string): unknown {
  const body = response.body.startsWith(BYTE_ORDER_MARK) ? response.body.slice(1) : response.body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new UnexpectedResponseError(`${what} did not answer with JSON.`);
  }
}

/** Parses a JSON object body; anything else is unexpected. */
export function readObject(response: HttpResponse, what: string): Json {
  const payload = readJson(response, what);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`${what} did not answer with a JSON object.`);
  }
  return payload;
}
