import {
  carrierPattern,
  asArray,
  asObject,
  expectStatus,
  isObject,
  newestFirst,
  readJson,
  snapshot,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import { CARRIER_ID, isoTime, mapCode, publicUrl, text, TRACKING_HOST } from "./shared.js";

/** Hermes parcel numbers are digits (sometimes letters for international ones); anything else is never sent. */
const BARCODE_PATTERN = carrierPattern("hermes");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Looks one code up on the public tracking endpoint. Returns null when Hermes does not know it
 * (404), considers it malformed (400) or answers with an empty list; all of these are normal.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/tnt/v2/shipments/search/${encodeURIComponent(barcode)}`,
  );
  const response = await http.request(url, {
    headers: { accept: "application/json", "x-language": "de" },
  });
  if (response.status === 400 || response.status === 404) {
    return null;
  }
  expectStatus(response, "Hermes tracking", 200);
  const payload = readJson(response, "Hermes tracking");
  if (!Array.isArray(payload)) {
    throw new UnexpectedResponseError("Hermes tracking did not answer with a list.");
  }
  if (payload.length === 0) {
    return null;
  }
  if (!payload.every(isObject)) {
    throw new UnexpectedResponseError("Hermes tracking listed something that is not a shipment.");
  }
  // The shipment that is the code asked for; a single answer is the code's own shipment.
  const compact = (code: unknown): string => String(code).replace(/\s+/gu, "").toUpperCase();
  const asked = payload.find((entry) => compact(entry["barcode"]) === compact(barcode));
  if (asked !== undefined) {
    return asked;
  }
  if (payload.length > 1) {
    throw new UnexpectedResponseError("Hermes tracking answered with shipments not asked for.");
  }
  return payload[0] ?? null;
}

export interface Forecast {
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
}

/**
 * A real window when both ends are given; a parcel waiting in a PaketShop only gets the time it
 * is expected to be ready, a point estimate. `staticForecast` is a vague bucket and ignored.
 */
export function readForecast(raw: Json): Forecast {
  const forecast = asObject(raw["forecast"]);
  const from = isoTime(forecast["deliveryTimeFromUTC"]);
  const to = isoTime(forecast["deliveryTimeToUTC"]);
  if (from !== null && to !== null) {
    return { plannedFrom: from, plannedTo: to };
  }
  return { plannedFrom: from ?? isoTime(forecast["pickupReadyFromUTC"]), plannedTo: null };
}

function progressEvents(raw: Json): SnapshotEvent[] {
  const progress = asArray(raw["parcelProgress"]);
  const events: SnapshotEvent[] = [];
  for (const entry of progress) {
    const event = asObject(entry);
    const at = isoTime(event["timestamp"]);
    const code = text(event["parcelStatus"]);
    const description = text(event["historyText"]);
    const rawStatus = description ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    // Only the stable code is mapped: `status` is an outcome bucket (HAPPY, FINISHED), not text.
    events.push({ at, rawStatus, status: mapCode(code)?.status ?? null, location: null });
  }
  return newestFirst(events);
}

/** Turns one public tracking result into a snapshot; `report` receives unmapped codes. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const progress = asArray(raw["parcelProgress"]);
  // The list is newest first; the first entry is the current state.
  const latest = asObject(progress[0]);
  const code = text(latest["parcelStatus"]);
  const mapped = mapCode(code);
  if (code !== null && mapped === null) {
    report(code);
  }
  const status = mapped?.status ?? null;
  const attributes = asObject(raw["parcelAttributes"]);
  // The attribute block keeps `delivered` right even while a new terminal code is still unmapped.
  const delivered =
    status === "delivered" || (attributes["delivered"] === true && status !== "at_pickup_point");
  const forecast = readForecast(raw);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["barcode"]), barcode),
    status,
    rawStatus: text(latest["historyText"]) ?? code,
    delivered,
    deliveredAt: delivered
      ? status === "delivered"
        ? isoTime(latest["timestamp"])
        : isoTime(attributes["deliveredTimestamp"])
      : null,
    plannedFrom: delivered ? null : forecast.plannedFrom,
    plannedTo: delivered ? null : forecast.plannedTo,
    pickup: mapped?.pickup === true || status === "at_pickup_point",
    url: publicUrl(barcode),
    sender: text(asObject(raw["atg"])["companyName"]),
    history: progressEvents(raw),
    raw,
  });
}
