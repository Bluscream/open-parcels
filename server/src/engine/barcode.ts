import { findCarrier, loadRules } from "open-parcels-rules";

/**
 * Carriers whose "code" is an opaque token from a tracking link, where case matters. Their codes
 * are only trimmed.
 */
const TOKEN_CARRIERS: ReadonlySet<string> = new Set(["airmee", "budbee"]);

/** The shape of a tracking number for carriers the rules give no pattern for (UPS, DHL). */
const GENERIC_CODE = /^[A-Z0-9]{8,40}$/;

const patterns = new Map<string, RegExp>();

function patternOf(carrier: string): RegExp {
  let pattern = patterns.get(carrier);
  if (pattern === undefined) {
    pattern = findCarrier(loadRules(), carrier)?.trackingNumberPattern ?? GENERIC_CODE;
    patterns.set(carrier, pattern);
  }
  return pattern;
}

function matches(pattern: RegExp, code: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(code);
}

/**
 * The one spelling a carrier's code is stored in, so `1z 999…` typed by hand and `1Z999…` echoed
 * by the carrier are one parcel. Spaces go and letters are upper-cased when the result is a code
 * the carrier's tracking-number pattern accepts (for carriers without one, plain letters and
 * digits). Anything else (a shop's own key, an opaque link token, text the pattern rejects) is
 * only trimmed.
 */
export function normaliseBarcode(carrier: string, code: string): string {
  const trimmed = code.trim();
  if (TOKEN_CARRIERS.has(carrier)) {
    return trimmed;
  }
  const compact = trimmed.replace(/\s+/g, "").toUpperCase();
  return matches(patternOf(carrier), compact) ? compact : trimmed;
}
