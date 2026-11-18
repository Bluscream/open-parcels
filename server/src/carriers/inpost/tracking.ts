import type { PluginHttp } from "../../plugin/http.js";
import {
  snapshot,
  TransientError,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  asList,
  asObject,
  CARRIER_ID,
  isoTime,
  lookUpCode,
  newestFirst,
  parseBody,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
  type TrackingCountry,
} from "./shared.js";
import { TRACKING_STATUSES } from "./status.js";

/** InPost numbers are digits, sometimes with letters on cross-border parcels. */
const BARCODE_PATTERN = /^[A-Z0-9]{8,40}$/i;

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Looks one code up on the keyless public tracking. Null when InPost does not know it: HTTP 404,
 * or an answer without a tracking number that reports 404 itself. A body reporting status 500
 * is an outage behind an HTTP 200, not a parcel state.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${TRACKING_HOST}/api/tracking/${encodeURIComponent(barcode)}`);
  url.searchParams.set("language", "en");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`InPost tracking answered HTTP ${response.status}.`);
  }
  const payload = parseBody(response.body, "InPost tracking");
  if (text(payload["trackingNumber"]) !== null) {
    return payload;
  }
  if (payload["status"] === 404) {
    return null;
  }
  throw new TransientError(`InPost tracking answered without a parcel.`);
}

function detailEvents(raw: Json, report: (code: string) => void): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asList(raw["trackingDetails"])) {
    const detail = asObject(entry);
    const at = isoTime(detail["datetime"]);
    const code = text(detail["status"]);
    const rawStatus = text(detail["statusTitle"]) ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    const status = lookUpCode(TRACKING_STATUSES, code, report);
    events.push({ at, rawStatus, status, location: null });
  }
  return newestFirst(events);
}

/** One public tracking answer as a snapshot. The public tracking gives no delivery window. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  country: TrackingCountry,
  report: (code: string) => void,
): ParcelSnapshot {
  const code = text(raw["status"]);
  const status = lookUpCode(TRACKING_STATUSES, code, report);
  const history = detailEvents(raw, report);
  const delivered = status === "delivered";
  const number = text(raw["trackingNumber"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: number,
    status,
    rawStatus: text(raw["statusTitle"]) ?? code,
    delivered,
    deliveredAt: delivered
      ? (history.find((event) => event.status === "delivered")?.at ?? null)
      : null,
    pickup: status === "at_pickup_point",
    url: publicUrl(number, country),
    history,
    raw,
  });
}
