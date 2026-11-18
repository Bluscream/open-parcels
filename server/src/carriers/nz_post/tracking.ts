import {
  carrierPattern,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  CARRIER_ID,
  isObject,
  isoTime,
  mapStatus,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

/** NZ Post codes are letters and digits; anything else is never sent. */
const BARCODE_PATTERN = carrierPattern("nz_post");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Looks one code up. Returns null when NZ Post does not know it yet (status_code 2, no results,
 * or a result carrying errors); an unscanned parcel looks the same, which is normal.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${TRACKING_HOST}/tracking/api/parceltrack/parcels`);
  url.searchParams.set("tracking_reference", barcode);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`NZ Post tracking answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("NZ Post tracking did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("NZ Post tracking did not answer with an object.");
  }
  const results = payload["results"];
  if (payload["status_code"] === 2 || !Array.isArray(results)) {
    return null;
  }
  const first = (results as unknown[]).find(isObject);
  if (first === undefined) {
    return null;
  }
  const errors = first["errors"];
  if (Array.isArray(errors) ? errors.length > 0 : Boolean(errors)) {
    return null;
  }
  return first;
}

interface RawEvent {
  readonly at: string;
  readonly key: string;
}

/** Events with a usable time and a status key (text, else the numeric code), oldest first. */
function readEvents(raw: Json): RawEvent[] {
  const list = Array.isArray(raw["tracking_events"]) ? (raw["tracking_events"] as unknown[]) : [];
  const events: RawEvent[] = [];
  for (const entry of list) {
    if (!isObject(entry)) {
      continue;
    }
    const at = isoTime(entry["date_time"]);
    const key = text(entry["status"]) ?? text(entry["edifact_code"]);
    if (at !== null && key !== null) {
      events.push({ at, key });
    }
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Turns one tracking result into a snapshot; `report` receives unmapped status keys. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const events = readEvents(raw);
  const reported = new Set<string>();
  const map = (key: string) => {
    const status = mapStatus(key);
    if (status === null && !reported.has(key)) {
      reported.add(key);
      report(key);
    }
    return status;
  };
  const history: SnapshotEvent[] = events
    .map((event) => ({
      at: event.at,
      rawStatus: event.key,
      status: map(event.key),
      location: null,
    }))
    .reverse();
  const latest = history[0];
  const status = latest?.status ?? null;
  const delivered = status === "delivered";
  const code = text(raw["tracking_reference"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: latest?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered ? (history.find((e) => e.status === "delivered")?.at ?? null) : null,
    url: publicUrl(code),
    history,
    // Locations and signer names are personal enough to keep out of the stored payload.
    raw: { tracking_events: events },
  });
}
