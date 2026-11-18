import type { ParcelStatus } from "../../domain/parcel.js";
import type { PluginHttp } from "../../plugin/http.js";
import {
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type ParcelSnapshot,
  type PluginContext,
  type RequestOptions,
  type SnapshotEvent,
} from "../../plugin/api.js";

/**
 * Small helpers shared by the simpler carrier plug-ins: narrowing untrusted JSON, reading a
 * response defensively and mapping a status through a local table.
 */

export type Json = Readonly<Record<string, unknown>>;
export type { ParcelStatus };

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
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

/** A trimmed non-empty string, or null. Numbers are accepted and turned into text. */
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

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * ISO 8601 for a string or an epoch-millisecond number. A string without a zone is read as
 * UTC unless `assumeOffset` (like `+01:00`) says what the carrier means.
 */
export function isoTime(value: unknown, assumeOffset = "Z"): string | null {
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
  const parsed = new Date(hasZone ? withTime : `${withTime.replace(" ", "T")}${assumeOffset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** History newest first; ties keep the carrier's order. */
export function newestFirst(events: readonly SnapshotEvent[]): SnapshotEvent[] {
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Parses a JSON body; anything else is a response that looks wrong and stops the run. */
export function parseJson(response: HttpResponse, label: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`${label} did not answer with JSON.`);
  }
}

/**
 * Sends one request and returns the parsed JSON for a 200. Statuses in `notFound` give null;
 * every other status is a transient failure (rate limits are raised by the HTTP layer).
 */
export async function requestJson(
  http: PluginHttp,
  url: URL,
  label: string,
  options: RequestOptions & { readonly notFound?: readonly number[] } = {},
): Promise<unknown> {
  const response = await http.request(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  });
  if (options.notFound?.includes(response.status) === true) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`${label} answered HTTP ${response.status}.`);
  }
  return parseJson(response, label);
}

/** Maps a raw value through a local table; an unmapped, non-empty value is reported once. */
export function mapLocal(
  table: Readonly<Record<string, ParcelStatus>>,
  code: string | null,
  report?: (code: string) => void,
): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const mapped = Object.hasOwn(table, code) ? table[code] : undefined;
  if (mapped === undefined) {
    report?.(code);
    return null;
  }
  return mapped;
}

/** A reporter that files unmapped values under `status_code`. */
export function statusReporter(
  context: Pick<PluginContext<unknown, unknown>, "reportUnknown">,
): (code: string) => void {
  return (code) => {
    context.reportUnknown("status_code", code);
  };
}

/**
 * Looks codes up one at a time, so the host limiter paces them and an error stops the run
 * before more requests go out. Implausible codes are never sent.
 */
export async function trackOneByOne(
  barcodes: readonly string[],
  plausible: RegExp,
  lookUp: (barcode: string) => Promise<ParcelSnapshot | null>,
): Promise<{ snapshots: ParcelSnapshot[]; complete: true }> {
  const snapshots: ParcelSnapshot[] = [];
  for (const barcode of barcodes) {
    if (!plausible.test(barcode)) {
      continue;
    }
    const parcel = await lookUp(barcode);
    if (parcel !== null) {
      snapshots.push(parcel);
    }
  }
  return { snapshots, complete: true };
}

/** Joins non-empty parts with `, `; null when nothing is left. */
export function joinParts(...parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== "");
  return kept.length === 0 ? null : kept.join(", ");
}
