/**
 * Value-level redaction for anything that may leave the machine: log lines, diagnostics and
 * error reports. Key-based redaction (tokens, cookies, passwords) is done by pino's `redact`
 * paths; this catches personal data that appears inside free text.
 */

const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Latitude/longitude-looking decimals with at least four fractional digits. */
const COORDINATE = /-?\b\d{1,3}\.\d{4,}\b/g;
/** Long runs of digits or letter-prefixed codes typical for tracking and order numbers. */
const LONG_CODE = /\b(?:[A-Z]{1,4})?\d{8,}[A-Z]{0,3}\b/g;
const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;

/** Keeps a short prefix so log lines stay correlatable without exposing the full value. */
function maskCode(value: string): string {
  return `${value.slice(0, 4)}…`;
}

export function redactText(text: string): string {
  return text
    .replace(BEARER, "$1 [redacted]")
    .replace(EMAIL, "[email]")
    .replace(AMAZON_ORDER, (match) => maskCode(match))
    .replace(COORDINATE, "[coord]")
    .replace(LONG_CODE, (match) => maskCode(match));
}

/** Keys whose values are never written anywhere, wherever they appear in an object. */
export const SECRET_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "cookies",
  "set-cookie",
  "csrf",
  "csrfToken",
  "otpSecret",
  "apiKey",
  "api_key",
  "pin",
] as const;

const SECRET_KEY_SET = new Set<string>(SECRET_KEYS.map((key) => key.toLowerCase()));

const MAX_DEPTH = 8;

/** Deep copy with secret keys removed and free text redacted. Used for diagnostics output. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[depth]";
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = SECRET_KEY_SET.has(key.toLowerCase())
        ? "[redacted]"
        : redactValue(inner, depth + 1);
    }
    return result;
  }
  return value;
}
