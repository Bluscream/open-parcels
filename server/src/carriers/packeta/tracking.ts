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
  asObject,
  CARRIER_ID,
  isoTime,
  mapCode,
  mapEventText,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = carrierPattern("packeta");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/** The error values that mean "no such parcel"; any other error is a failure, not a missing code. */
const NOT_FOUND_ERRORS = new Set(["notfound", "packetnotfound", "not found"]);

/** Looks one code up. 404, or a 200 carrying a not-found error instead of an item, means not found. */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/api/getPacketById/${encodeURIComponent(barcode)}/en`,
  );
  const response = await http.request(url, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Packeta tracking answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Packeta tracking did not answer with JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new UnexpectedResponseError("Packeta tracking did not answer with an object.");
  }
  const item: unknown = (payload as Json)["item"];
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    return item as Json;
  }
  const error: unknown = (payload as Json)["error"];
  if (typeof error === "string" && NOT_FOUND_ERRORS.has(error.toLowerCase())) {
    return null;
  }
  if (error !== undefined) {
    throw new UnexpectedResponseError(
      "Packeta tracking answered with an error it does not explain.",
    );
  }
  throw new UnexpectedResponseError("Packeta tracking answered without an item.");
}

function events(raw: Json, report: (sentence: string) => void): SnapshotEvent[] {
  const list: unknown = raw["trackingDetails"];
  const result: SnapshotEvent[] = [];
  for (const entry of Array.isArray(list) ? (list as unknown[]) : []) {
    const event = asObject(entry);
    const at = isoTime(event["time"]);
    const sentence = text(event["text"]);
    if (at === null || sentence === null) {
      continue;
    }
    const status = mapEventText(sentence);
    if (status === null) {
      report(sentence);
    }
    result.push({ at, rawStatus: sentence, status, location: null });
  }
  return result.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Packeta gives no delivery window; the pickup point is named as soon as one is assigned. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  reportCode: (code: string) => void,
  reportText: (sentence: string) => void,
): ParcelSnapshot {
  const id: unknown = raw["packetStatusId"];
  const code = typeof id === "number" ? String(id) : text(id);
  const status = mapCode(code);
  if (code !== null && status === null) {
    reportCode(code);
  }
  const history = events(raw, reportText);
  const delivered = status === "delivered";
  const pickupPoint = text(raw["branchAddress"]);
  const ownCode = text(raw["barcode"]);
  return snapshot({
    carrier: CARRIER_ID,
    // Filed under the code as tracked; Packeta's own spelling is only a reference.
    barcode,
    externalRef: ownCode !== null && ownCode !== barcode ? ownCode : null,
    status,
    rawStatus: text(raw["packetStatus"]) ?? code,
    delivered,
    // No delivered-at field: the newest event marks the delivery.
    deliveredAt: delivered ? (history[0]?.at ?? null) : null,
    pickup: pickupPoint !== null,
    pickupPoint,
    url: publicUrl(ownCode ?? barcode),
    sender: text(raw["sender"]),
    history,
    raw,
  });
}
