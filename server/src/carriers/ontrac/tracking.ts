import {
  carrierPattern,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import {
  asObject,
  CARRIER_ID,
  isObject,
  isoTime,
  mapCode,
  num,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

/** OnTrac numbers are letters and digits; anything else is never sent. */
const BARCODE_PATTERN = carrierPattern("ontrac");
const LB_IN_KG = 0.45359237;
const PERSONAL_KEYS = new Set([
  "Consignee",
  "SignatureImageString",
  "SignatureImageFormat",
  "PodText",
]);

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new UnexpectedResponseError("OnTrac tracking did not answer with JSON.");
  }
}

/**
 * Looks one code up. Returns null for the structured "Not Found" 404 or an empty package list;
 * any other 404 or non-200 answer is an error.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/PackageServices/tracking/${encodeURIComponent(barcode)}`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    const problem = asObject(parseJson(response.body));
    if (problem["Title"] === "Not Found" || problem["Status"] === 404) {
      return null;
    }
    throw new UnexpectedResponseError("OnTrac answered 404 with an unexpected body.");
  }
  if (response.status !== 200) {
    throw new TransientError(`OnTrac tracking answered HTTP ${response.status}.`);
  }
  const payload = parseJson(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("OnTrac tracking did not answer with an object.");
  }
  const packages = payload["Packages"];
  if (!Array.isArray(packages) || packages.length === 0) {
    return null;
  }
  const first: unknown = packages[0];
  if (!isObject(first)) {
    throw new UnexpectedResponseError("OnTrac listed something that is not a package.");
  }
  return first;
}

function readEvents(raw: Json, report: (code: string) => void): SnapshotEvent[] {
  const list = Array.isArray(raw["Events"]) ? (raw["Events"] as unknown[]) : [];
  const events: SnapshotEvent[] = [];
  for (const entry of list) {
    const event = asObject(entry);
    const at = isoTime(event["UtcEventDateTime"]);
    const code = text(event["EventCode"]);
    if (at === null || code === null) {
      continue;
    }
    const status = mapCode(code);
    if (status === null) {
      report(code);
    }
    events.push({ at, rawStatus: code, status, location: text(event["City"]) });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function weightKg(raw: Json): number | null {
  const weight = num(raw["Weight"]);
  if (weight === null) {
    return null;
  }
  const unit = text(raw["WeightUnits"]);
  if (unit === "lbs") {
    return Math.round(weight * LB_IN_KG * 100) / 100;
  }
  return unit === "kg" ? Math.round(weight * 100) / 100 : null;
}

/** Turns one package into a snapshot; `report` receives unmapped event codes once each. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const seen = new Set<string>();
  const reportOnce = (code: string): void => {
    if (!seen.has(code)) {
      seen.add(code);
      report(code);
    }
  };
  const history = readEvents(raw, reportOnce);
  const latest = history[0];
  const status = latest?.status ?? null;
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["Tracking"]), barcode),
    status,
    rawStatus: latest?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered ? isoTime(raw["UtcDeliveryDateTime"]) : null,
    plannedTo: delivered ? null : isoTime(raw["UtcExpectedDeliveryDateTime"]),
    url: publicUrl(barcode),
    weightKg: weightKg(raw),
    history,
    raw: withoutPersonalData(raw),
  });
}

/** The recipient block and proof of delivery can name a person; they never leave the plug-in. */
function withoutPersonalData(raw: Json): Json {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !PERSONAL_KEYS.has(key)));
}
