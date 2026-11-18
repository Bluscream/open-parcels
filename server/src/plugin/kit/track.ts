import type { FetchResult, PluginContext } from "../api.js";
import { TransientError } from "../errors.js";
import type { HttpResponse } from "../http.js";
import type { ParcelSnapshot, SnapshotEvent } from "../snapshot.js";

/** A canonical status, as a plug-in's local status table holds it. */
export type Status = NonNullable<ParcelSnapshot["status"]>;
export type StatusTable = Readonly<Record<string, Status>>;

/** Looks a raw value up in a local table; unknown and empty values give null. */
export function lookUpStatus(table: StatusTable, key: string | null): Status | null {
  return key !== null && Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** Reports each unmapped key once per run, under one kind. */
export function unknownReporter(
  context: Pick<PluginContext<unknown, unknown>, "reportUnknown">,
  kind: string,
): (key: string) => void {
  const seen = new Set<string>();
  return (key) => {
    if (!seen.has(key)) {
      seen.add(key);
      context.reportUnknown(kind, key);
    }
  };
}

/** Throws a transient error for anything but a 2xx answer. */
export function expectOk(response: HttpResponse, what: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new TransientError(`${what} answered HTTP ${response.status}.`);
  }
}

export interface TrackOptions {
  /** Codes that do not match are never sent. */
  readonly plausible: RegExp;
  /** Spelling of a code as it is checked and sent. Default: trimmed upper case. */
  readonly normalize?: (code: string) => string;
}

const defaultNormalize = (code: string): string => code.trim().toUpperCase();

/**
 * Looks codes up one at a time, so the host limiter paces them and the first error stops the
 * run before more requests go out. `lookUp` gets the code as sent and as tracked; snapshots
 * carry the tracked spelling. A null answer means "not found" and leaves the code out.
 */
export async function trackEach(
  barcodes: readonly string[],
  options: TrackOptions,
  lookUp: (code: string, tracked: string) => Promise<ParcelSnapshot | null>,
): Promise<FetchResult> {
  const normalize = options.normalize ?? defaultNormalize;
  const snapshots: ParcelSnapshot[] = [];
  const done = new Set<string>();
  for (const barcode of barcodes) {
    const code = normalize(barcode);
    if (done.has(code) || !options.plausible.test(code)) {
      continue;
    }
    done.add(code);
    const found = await lookUp(code, barcode);
    if (found !== null) {
      snapshots.push(found);
    }
  }
  return { snapshots, complete: true };
}

/** The newest history entry with a mapped status, for the suite's status fallback. */
export function newestMapped(history: readonly SnapshotEvent[]): SnapshotEvent | null {
  return history.find((event) => event.status !== null) ?? null;
}
