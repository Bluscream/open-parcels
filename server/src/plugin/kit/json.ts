/**
 * Narrowing helpers for untrusted carrier payloads, and reading a response body as JSON. Every
 * plug-in uses these instead of carrying its own copy; they reach plug-ins through the plug-in API.
 */
import { TransientError, UnexpectedResponseError } from "../errors.js";
import type { HttpResponse } from "../http.js";

export type Json = Readonly<Record<string, unknown>>;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an object, or an empty one, so lookups on it are always safe. */
export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

/** The value as a list, or an empty one. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The objects in a list; anything else in it, or a value that is not a list, is dropped. */
export function objects(value: unknown): Json[] {
  return asArray(value).filter(isObject);
}

/** Walks `keys` through nested objects; anything that is not an object on the way gives undefined. */
export function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export interface TextOptions {
  /**
   * Whether a finite number counts as its decimal text. Default true. Pass false for carriers
   * whose numeric fields must never be read as text.
   */
  readonly numbers?: boolean;
}

/** A trimmed, non-empty string, or null. Numbers are accepted as their decimal text by default. */
export function text(value: unknown, options: TextOptions = {}): string | null {
  if (typeof value === "number" && Number.isFinite(value) && options.numbers !== false) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface NumOptions {
  /** Read numeric strings too. Default true. */
  readonly strings?: boolean;
  /** Read a comma in a numeric string as the decimal separator (`1,5` is 1.5). Default false. */
  readonly decimalComma?: boolean;
}

/** A finite number, from a number or (by default) a numeric string; null otherwise. */
export function num(value: unknown, options: NumOptions = {}): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (options.strings === false || typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const raw = value.trim();
  const parsed = Number(options.decimalComma === true ? raw.replace(",", ".") : raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A positive number (a weight, a count), or null. Commas are decimal separators. */
export function positive(value: unknown): number | null {
  const parsed = num(value, { decimalComma: true });
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** Joins the non-empty parts with `, `; null when nothing is left. */
export function joinParts(...parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.filter(
    (part): part is string => part !== null && part !== undefined && part !== "",
  );
  return kept.length === 0 ? null : kept.join(", ");
}

/** The body parsed as JSON, tolerating a byte-order mark, or null when it is not JSON. */
export function parseJsonBody(body: string): unknown {
  const clean = body.startsWith(BYTE_ORDER_MARK) ? body.slice(1) : body;
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return null;
  }
}

/** The body as JSON. A body that is not JSON is an unexpected response that stops the run. */
export function readJson(response: HttpResponse, carrier: string): unknown {
  const clean = response.body.startsWith(BYTE_ORDER_MARK) ? response.body.slice(1) : response.body;
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    throw new UnexpectedResponseError(`${carrier} did not answer with JSON.`);
  }
}

/** Like `readJson`, but the answer must be an object. */
export function readObject(response: HttpResponse, carrier: string): Json {
  const payload = readJson(response, carrier);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`${carrier} did not answer with a JSON object.`);
  }
  return payload;
}

/**
 * The list under `key`, which must be there. A missing or renamed key is an unexpected answer that
 * stops the run, never an empty list: an account reading it as empty would mark every parcel gone.
 */
export function requiredList(payload: Json, key: string, carrier: string): readonly unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new UnexpectedResponseError(`${carrier} answered without its "${key}" list.`);
  }
  return value as unknown[];
}

/** OAuth `error` values that mean the grant or client was refused, so signing in again is needed. */
const OAUTH_REFUSALS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
  "invalid_token",
  "login_required",
]);

/**
 * True when a token endpoint's 400 or 401 is an OAuth refusal (its `error` names one). Any other
 * 400 or 401 (a proxy page, a changed endpoint, a malformed request) is not the user's sign-in
 * failing, and must not ask them to sign in again.
 */
export function isOAuthRefusal(response: HttpResponse): boolean {
  if (response.status !== 400 && response.status !== 401) {
    return false;
  }
  const error = asObject(parseJsonBody(response.body))["error"];
  return typeof error === "string" && OAUTH_REFUSALS.has(error);
}

/**
 * Any status other than the expected ones is a temporary failure, retried with backoff. With no
 * statuses given, any 2xx answer is expected.
 */
export function expectStatus(response: HttpResponse, carrier: string, ...ok: number[]): void {
  const fine =
    ok.length === 0
      ? response.status >= 200 && response.status < 300
      : ok.includes(response.status);
  if (!fine) {
    throw new TransientError(`${carrier} answered HTTP ${response.status}.`);
  }
}
