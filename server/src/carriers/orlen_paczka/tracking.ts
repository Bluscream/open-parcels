import {
  carrierPattern,
  echoRef,
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
  code,
  isObject,
  isoTime,
  mapCode,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = carrierPattern("orlen_paczka");
const PREFIX = "callback(";
const SUFFIX = ");";
/** Errors that do not mean "no such parcel": the code is kept, its status unknown. */
const KEPT_ERRORS = new Set([1003, 1004]);

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

export type LookUpResult = { readonly raw: Json } | { readonly untrackable: string } | null;

/**
 * Looks one code up. The answer is JSON wrapped in `callback(…);`, which is only unwrapped and
 * parsed, never run. Returns null for the empty "no data" envelope.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<LookUpResult> {
  const url = new URL(`https://${TRACKING_HOST}/parcel/api-status`);
  url.searchParams.set("id", barcode);
  url.searchParams.set("jsonp", "callback");
  const response = await http.request(url, { timeoutMs: 20_000 });
  if (response.status !== 200) {
    throw new TransientError(`ORLEN Paczka tracking answered HTTP ${response.status}.`);
  }
  const body = response.body.trim();
  if (!body.startsWith(PREFIX) || !body.endsWith(SUFFIX)) {
    throw new UnexpectedResponseError("ORLEN Paczka did not answer with the expected wrapper.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.slice(PREFIX.length, -SUFFIX.length));
  } catch {
    throw new UnexpectedResponseError("ORLEN Paczka did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("ORLEN Paczka did not answer with an object.");
  }
  const error = payload["err"];
  if (typeof error === "number" && KEPT_ERRORS.has(error)) {
    return { untrackable: String(error) };
  }
  const history = payload["history"];
  if (payload["status"] === "" && (!Array.isArray(history) || history.length === 0)) {
    return null;
  }
  if (payload["status"] !== "OK" || !Array.isArray(history)) {
    throw new UnexpectedResponseError("ORLEN Paczka answered with an unexpected envelope.");
  }
  return { raw: payload };
}

function readEvents(raw: Json): SnapshotEvent[] {
  const list = Array.isArray(raw["history"]) ? (raw["history"] as unknown[]) : [];
  const events: SnapshotEvent[] = [];
  for (const entry of list) {
    const event = asObject(entry);
    const at = isoTime(event["date"]);
    const eventCode = code(event["code"]);
    const label = text(event["label"]);
    const rawStatus = label ?? text(event["labelShort"]) ?? eventCode;
    if (at === null || rawStatus === null) {
      continue;
    }
    events.push({ at, rawStatus, status: mapCode(eventCode, label), location: null });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A code ORLEN refuses to track; kept with an unknown status rather than dropped. */
export function untrackableSnapshot(barcode: string, error: string): ParcelSnapshot {
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status: null,
    rawStatus: `err ${error}`,
    raw: { err: error },
  });
}

/** Turns one answer into a snapshot; `report` receives an unmapped latest code. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const list = Array.isArray(raw["history"]) ? (raw["history"] as unknown[]) : [];
  // The carrier lists oldest first; the last entry is the current state.
  const latest = asObject(list.at(-1));
  const latestCode = code(latest["code"]);
  const label = text(latest["label"]);
  const status = mapCode(latestCode, label);
  if (latestCode !== null && status === null) {
    report(latestCode);
  }
  const delivered = status === "delivered";
  // The HTML rendering of the history is display markup only and is not kept.
  const safe = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "historyHtml"));
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["truckNo"]) ?? text(raw["number"]), barcode),
    status,
    rawStatus: label ?? text(raw["label"]) ?? latestCode,
    delivered,
    deliveredAt: delivered ? isoTime(latest["date"]) : null,
    pickup: status === "at_pickup_point",
    history: readEvents(raw),
    raw: safe,
  });
}
