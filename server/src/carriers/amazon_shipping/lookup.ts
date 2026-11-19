import {
  type PluginHttp,
  asArray,
  asObject,
  isObject,
  readObject,
  rulesTrackingUrl,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
} from "../../plugin/api.js";

/** The parcel exists but its history has been purged. */
export const HISTORY_EXPIRED = "SHIPMENT_OLDER_THAN_SUPPORTED_AGE";
/** Tracker sources the by-number tracker serves: Amazon Shipping and multi-channel fulfilment. */
const SERVED_SOURCES = new Set(["SWA", "MCF"]);
/** Answers that only mean "this tracker does not serve that number". */
const NOT_SERVED = new Set([
  "TRACKING_ID_NOT_FOUND",
  "INVALID_TRACKING_ID",
  "ERROR_INVALID_OFF_AMAZON_ORDER",
]);
/** Fields that arrive as JSON text inside the JSON body. */
const NESTED = ["progressTracker", "eventHistory", "addresses"] as const;

interface Region {
  readonly tld: string;
  /** Picks the regional tracking page in the shared rules; undefined for the default (.com). */
  readonly locale: string | undefined;
  /** The zone the tracker's offset-less times are read in; null when it cannot be known. */
  readonly zone: string | null;
}

const REGIONS: Readonly<Record<string, Region>> = {
  UK: { tld: "co.uk", locale: "en-GB", zone: "Europe/London" },
  GB: { tld: "co.uk", locale: "en-GB", zone: "Europe/London" },
  IT: { tld: "it", locale: "it", zone: "Europe/Rome" },
  ES: { tld: "es", locale: "es", zone: "Europe/Madrid" },
};
const FRANCE: Region = { tld: "fr", locale: "fr", zone: "Europe/Paris" };
/** US numbers span several zones, so their local times are kept for ordering only. */
const US: Region = { tld: "com", locale: undefined, zone: null };

/** The regional tracker for a number's prefix; the tracker's answer decides whether it serves it. */
export function regionFor(barcode: string): Region {
  const code = barcode.toUpperCase();
  if (/^TB[ACM]/.test(code) || !/^[A-Z]/.test(code)) {
    return US;
  }
  return REGIONS[code.slice(0, 2)] ?? FRANCE;
}

export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl("amazon_shipping", barcode, regionFor(barcode).locale);
}

function decodeNested(payload: Json): Json {
  const decoded: Record<string, unknown> = { ...payload };
  for (const name of NESTED) {
    const value = decoded[name];
    if (typeof value !== "string") {
      continue;
    }
    try {
      decoded[name] = JSON.parse(value) as unknown;
    } catch {
      throw new UnexpectedResponseError(`Amazon Shipping sent ${name} that is not valid JSON.`);
    }
  }
  if (!isObject(decoded["progressTracker"])) {
    throw new UnexpectedResponseError("Amazon Shipping answered without a progress tracker.");
  }
  const history = decoded["eventHistory"];
  if (history !== undefined && history !== null && !isObject(history)) {
    throw new UnexpectedResponseError(
      "Amazon Shipping sent an event history that is not an object.",
    );
  }
  return decoded;
}

/**
 * Looks one number up. The tracker answers HTTP 200 for every outcome, so the body decides:
 * a served parcel (or one whose history expired) comes back, anything it does not serve is null.
 */
export async function lookUp(
  http: PluginHttp,
  barcode: string,
  report: (kind: string, key: string) => void,
): Promise<Json | null> {
  const { tld } = regionFor(barcode);
  const path = encodeURIComponent(barcode);
  const response = await http.request(new URL(`https://track.amazon.${tld}/api/tracker/${path}`), {
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      // The tracker's own page, as a browser on it would send; part of the request, so not
      // taken from the shared rules' display link.
      referer: `https://track.amazon.${tld}/tracking/${path}`,
    },
  });
  if (response.status !== 200) {
    throw new TransientError(`Amazon Shipping tracking answered HTTP ${response.status}.`);
  }
  const envelope = decodeNested(readObject(response, "Amazon Shipping tracking"));
  const tracker = asObject(envelope["progressTracker"]);
  const errors = asArray(tracker["errors"])
    .map((error) => text(asObject(error)["errorCode"]))
    .filter((code) => code !== null);
  if (errors.includes(HISTORY_EXPIRED)) {
    return envelope;
  }
  for (const code of errors) {
    if (!NOT_SERVED.has(code)) {
      report("tracker_error", code);
    }
  }
  const source = text(tracker["trackerSource"]);
  if (source !== null && SERVED_SOURCES.has(source) && errors.length === 0) {
    return envelope;
  }
  if (source !== null && !SERVED_SOURCES.has(source) && source !== "UNKNOWN") {
    report("tracker_source", source);
  }
  return null;
}
