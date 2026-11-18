import {
  snapshot,
  TransientError,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { readOrder } from "./page.js";
import {
  asObject,
  CARRIER_ID,
  isoTime,
  mapLabel,
  newestFirst,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = /^[A-Z0-9-]{6,40}$/i;
const POSTCODE_PATTERN = /^[A-Z0-9 -]{3,10}$/i;

export function isPlausible(barcode: string, postalCode: string): boolean {
  return BARCODE_PATTERN.test(barcode) && POSTCODE_PATTERN.test(postalCode);
}

/**
 * Looks one code up. Paack keys the lookup on code and delivery postcode; an unknown pair is
 * answered with a redirect to an error page (or 404), which means "not found".
 */
export async function lookUp(
  http: PluginHttp,
  barcode: string,
  postalCode: string,
): Promise<Json | null> {
  const url = new URL(`https://${TRACKING_HOST}/shipments/tracking/order`);
  url.searchParams.set("tracking_number", barcode);
  url.searchParams.set("postal_code", postalCode);
  const response = await http.request(url, {
    redirect: "manual",
    headers: { accept: "text/html" },
  });
  if ((response.status >= 300 && response.status < 400) || response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Paack tracking answered HTTP ${response.status}.`);
  }
  return readOrder(response.body);
}

function events(raw: Json): SnapshotEvent[] {
  const list: unknown = raw["eventList"] ?? raw["events"];
  const result: SnapshotEvent[] = [];
  for (const entry of Array.isArray(list) ? (list as unknown[]) : []) {
    const event = asObject(entry);
    const at = isoTime(event["timestamp"]);
    const code = text(event["label"]) ?? text(event["statusCode"]);
    const rawStatus = code ?? text(event["description"]);
    if (at === null || rawStatus === null) {
      continue;
    }
    result.push({ at, rawStatus, status: mapLabel(code), location: null });
  }
  return newestFirst(result);
}

function window(raw: Json, track: Json): { from: string | null; to: string | null } {
  const expected: unknown = track["expected_delivery_ts"];
  const eta = asObject(raw["estimatedDelivery"]);
  const isRange = typeof expected === "object" && expected !== null;
  const from = isRange ? isoTime(asObject(expected)["start"]) : isoTime(eta["from"]);
  const to = isRange ? isoTime(asObject(expected)["end"]) : isoTime(expected ?? eta["to"]);
  // The same instant twice is a point estimate, not a window.
  return { from: from ?? to, to: from !== null && to !== from ? to : null };
}

export function trackingSnapshot(
  raw: Json,
  barcode: string,
  postalCode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const track = asObject(raw["orderTrackData"]);
  const active = asObject(raw["activeEvent"]);
  const code = text(active["label"]) ?? text(raw["statusCode"]);
  const status = mapLabel(code);
  if (code !== null && status === null) {
    report(code);
  }
  const delivered = status === "delivered";
  const planned = window(raw, track);
  const ownCode = text(track["external_id"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: ownCode,
    status,
    rawStatus: code ?? text(raw["statusText"]),
    delivered,
    deliveredAt: delivered ? isoTime(active["timestamp"] ?? raw["deliveredAt"]) : null,
    plannedFrom: delivered ? null : planned.from,
    plannedTo: delivered ? null : planned.to,
    pickup: status === "at_pickup_point",
    pickupPoint: text(track["pudo_name"]) ?? text(asObject(raw["pickupPoint"])["name"]),
    url: publicUrl(ownCode, postalCode),
    sender: text(track["retailer_name"]) ?? text(raw["sender"]),
    history: events(raw),
    raw,
  });
}
