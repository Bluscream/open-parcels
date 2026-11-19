import type { ParcelStatus } from "../../domain/parcel.js";
import type { FetchResult, PluginContext } from "../api.js";
import { TransientError } from "../errors.js";
import type { HttpResponse, PluginHttp, RequestOptions } from "../http.js";
import type { ParcelSnapshot } from "../snapshot.js";
import { readJson } from "./json.js";

export type { ParcelStatus } from "../../domain/parcel.js";

/** A carrier's own status vocabulary mapped onto the canonical list. */
export type StatusTable = Readonly<Record<string, ParcelStatus>>;

/**
 * Looks a raw value up in a local table. Empty values give null; an unmapped value gives null and
 * is passed to `report`, when one is given.
 */
export function lookUpStatus(
  table: StatusTable,
  key: string | null,
  report?: (key: string) => void,
): ParcelStatus | null {
  if (key === null) {
    return null;
  }
  const mapped = Object.hasOwn(table, key) ? table[key] : undefined;
  if (mapped === undefined) {
    report?.(key);
    return null;
  }
  return mapped;
}

export interface ReporterOptions {
  /** Report each key once per reporter (default) or every time it is seen. */
  readonly once?: boolean;
}

/** A function that reports unmapped keys under one kind. */
export function unknownReporter(
  context: Pick<PluginContext<unknown, unknown>, "reportUnknown">,
  kind: string,
  options: ReporterOptions = {},
): (key: string) => void {
  const seen = new Set<string>();
  return (key) => {
    if (options.once === false || !seen.has(key)) {
      seen.add(key);
      context.reportUnknown(kind, key);
    }
  };
}

export interface TrackOptions {
  /** Codes that do not match are never sent. */
  readonly plausible: RegExp;
  /** Spelling of a code as it is checked and sent. Default: trimmed upper case. */
  readonly normalize?: (code: string) => string;
  /** Look a code up only once when it is listed twice. Default true. */
  readonly dedupe?: boolean;
}

const defaultNormalize = (code: string): string => code.trim().toUpperCase();
const asGiven = (code: string): string => code;

/**
 * A lookup's answer filed under the code as tracked. Carriers often echo their own number (a
 * parcel number, a token, a reformatted code); that one is kept as the external reference, never
 * as the barcode, so the answer can never become a second parcel. A hand-off keeps its own key.
 */
export function asTracked(found: ParcelSnapshot, tracked: string): ParcelSnapshot {
  if (found.barcode === tracked) {
    return found;
  }
  return { ...found, barcode: tracked, externalRef: found.externalRef ?? found.barcode };
}

/**
 * The carrier's own number for a tracked parcel, as the external reference: null when it is
 * missing or the same as the code tracked. The barcode stays the code tracked.
 */
export function echoRef(echo: string | null, tracked: string): string | null {
  return echo === null || echo === tracked ? null : echo;
}

/**
 * Looks codes up one at a time, so the host limiter paces them and the first error stops the run
 * before more requests go out. `lookUp` gets the code as sent and as tracked. A null answer means
 * "not found" and leaves the code out.
 *
 * Passing just a pattern checks and sends codes exactly as given, without de-duplication.
 */
export async function trackEach(
  barcodes: readonly string[],
  options: RegExp | TrackOptions,
  lookUp: (code: string, tracked: string) => Promise<ParcelSnapshot | null>,
): Promise<FetchResult> {
  const settings: TrackOptions =
    options instanceof RegExp ? { plausible: options, normalize: asGiven, dedupe: false } : options;
  const normalize = settings.normalize ?? defaultNormalize;
  const snapshots: ParcelSnapshot[] = [];
  const done = new Set<string>();
  for (const barcode of barcodes) {
    const code = normalize(barcode);
    if ((settings.dedupe !== false && done.has(code)) || !settings.plausible.test(code)) {
      continue;
    }
    done.add(code);
    const found = await lookUp(code, barcode);
    if (found !== null) {
      snapshots.push(asTracked(found, barcode));
    }
  }
  // A lookup answers only for the codes asked; whether a missing one is gone is the not-found
  // lookup state's call (archived after 30 days), never the removal grace period's.
  return { snapshots, complete: false };
}

/**
 * Sends one request and returns the parsed JSON of a 200 answer. Statuses in `notFound` give
 * null; every other status is a transient failure (rate limits are raised by the HTTP layer).
 */
export async function requestJson(
  http: PluginHttp,
  url: URL,
  carrier: string,
  options: RequestOptions & { readonly notFound?: readonly number[] } = {},
): Promise<unknown> {
  const response: HttpResponse = await http.request(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  });
  if (options.notFound?.includes(response.status) === true) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`${carrier} answered HTTP ${response.status}.`);
  }
  return readJson(response, carrier);
}
