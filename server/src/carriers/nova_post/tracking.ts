import type { PluginHttp } from "../../plugin/http.js";
import {
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  asObject,
  CARRIER_ID,
  HISTORY_LIMIT,
  isObject,
  isoTime,
  publicUrl,
  RECEIVED_CODES,
  STATUS_MAP,
  text,
  TRACKING_HOST,
  UNDETERMINED_CODE,
  type Json,
} from "./shared.js";

/** Waybill numbers are digits; anything else is never sent. */
const BARCODE_PATTERN = /^[0-9]{8,20}$/;

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/** One waybill from the public website tracking. Null when the carrier does not know it (404). */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/site/v.1.0/shipments/tracking/${encodeURIComponent(barcode)}`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Nova Post tracking answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Nova Post tracking did not answer with JSON.");
  }
  if (!isObject(payload) || !Array.isArray(payload["tracking"])) {
    throw new UnexpectedResponseError("Nova Post tracking answered with an unknown shape.");
  }
  return payload;
}

/** The hops, oldest to newest as the carrier lists them. */
function hops(raw: Json): Json[] {
  const list = Array.isArray(raw["tracking"]) ? raw["tracking"] : [];
  return list.filter(isObject);
}

function mapCode(code: string | null, report: (code: string) => void): ParcelSnapshot["status"] {
  if (code === null) {
    return null;
  }
  const mapped = STATUS_MAP[code];
  if (mapped === undefined) {
    report(code);
    return null;
  }
  return mapped === "unknown" ? null : mapped;
}

/** Sender and recipient carry geography only (settlement, country), never a name. */
function place(party: unknown): string | null {
  const block = asObject(party);
  const parts = [text(block["settlement"]), text(block["country_code"])].filter((p) => p !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

function weightKg(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function history(list: readonly Json[]): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const hop of list) {
    const at = isoTime(hop["date"]);
    const code = text(hop["code"]);
    const rawStatus = text(hop["event_name"]) ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    const status = code === null ? null : (STATUS_MAP[code] ?? null);
    const location = text(hop["division_name"]);
    events.push({ at, status: status === "unknown" ? null : status, rawStatus, location });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, HISTORY_LIMIT);
}

/** Turns one tracking answer into a snapshot; `report` receives unmapped codes. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const list = hops(raw);
  const latest = list.at(-1) ?? {};
  const code = text(latest["code"]);
  const status = code === UNDETERMINED_CODE ? null : mapCode(code, report);
  const delivered = status === "delivered";
  // No field names the hand-over time; the newest "Received" hop is the best candidate.
  const receivedHop = [...list]
    .reverse()
    .find((hop) => RECEIVED_CODES.has(text(hop["code"]) ?? ""));
  // A single point estimate, not a window: both ends carry it.
  const planned = delivered ? null : isoTime(raw["scheduled_delivery_date"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(latest["event_name"]) ?? code,
    delivered,
    deliveredAt: delivered ? isoTime(receivedHop?.["date"]) : null,
    plannedFrom: planned,
    plannedTo: planned,
    pickup: status === "at_pickup_point",
    pickupPoint: text(latest["division_name"]),
    url: publicUrl(barcode),
    sender: place(raw["sender"]),
    receiver: place(raw["recipient"]),
    weightKg: weightKg(raw["total_weight"]),
    history: history(list),
    raw,
  });
}
