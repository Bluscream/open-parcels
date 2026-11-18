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
  eventTime,
  isObject,
  mapCode,
  newestFirst,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = /^[A-Z0-9]{6,40}$/i;
/** The only failure the service is known to use for a temporary backend problem. */
const RETRYABLE_ERROR = "upstream";

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

function parseBody(body: unknown): Json {
  if (!isObject(body)) {
    throw new UnexpectedResponseError("PDN Express did not answer with a JSON object.");
  }
  if (body["ok"] !== true) {
    if (body["error"] === RETRYABLE_ERROR) {
      throw new TransientError("PDN Express reported a temporary backend problem.");
    }
    throw new UnexpectedResponseError("PDN Express answered with an unknown failure envelope.");
  }
  const data = body["data"];
  const entry: unknown = Array.isArray(data) ? data[0] : undefined;
  if (!isObject(entry)) {
    throw new UnexpectedResponseError("PDN Express answered without an entry.");
  }
  return entry;
}

/**
 * Looks one code up; the endpoint reads several codes as one string, so it is always one per
 * request. Null for an unknown code, an inconclusive notice or an answer for another code.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${TRACKING_HOST}/api/track`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ action: "search", orderNos: barcode, locale: "en" }),
  });
  if (response.status !== 200) {
    throw new TransientError(`PDN Express tracking answered HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = response.json();
  } catch {
    throw new UnexpectedResponseError("PDN Express tracking did not answer with JSON.");
  }
  const entry = parseBody(body);
  if (entry["orderNo"] !== barcode) {
    return null;
  }
  const events = entry["events"];
  // An entry without events is the not-found notice, or an unfamiliar one: nothing to show.
  return Array.isArray(events) && events.length > 0 ? entry : null;
}

function stageName(event: Json): string | null {
  return text(asObject(event["statusCodeConfig"])["lanName"]);
}

function readEvents(raw: Json): Json[] {
  const events = Array.isArray(raw["events"]) ? (raw["events"] as unknown[]) : [];
  return events.filter(isObject);
}

/** The newest inline pickup site's shop name; only the name, never its address. */
function pickupSite(events: readonly Json[]): { seen: boolean; name: string | null } {
  for (const event of events) {
    const site = event["pickupSite"];
    if (isObject(site) && Object.keys(site).length > 0) {
      return { seen: true, name: text(site["pudoShopName"]) };
    }
  }
  return { seen: false, name: null };
}

/** Turns one entry into a snapshot; the carrier lists events newest first. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = readEvents(raw);
  const history: SnapshotEvent[] = [];
  let current: { event: Json; status: SnapshotEvent["status"] } | null = null;
  for (const event of events) {
    const code = text(event["eventCode"]);
    const status = mapCode(code, report);
    if (current === null && status !== null) {
      current = { event, status };
    }
    const at = eventTime(event);
    const rawStatus = text(event["eventDesc"]) ?? code ?? stageName(event);
    if (at !== null && rawStatus !== null) {
      history.push({ at, status, rawStatus, location: text(event["eventLocation"]) });
    }
  }
  const status = current?.status ?? null;
  const delivered = status === "delivered";
  const site = pickupSite(events);
  const pickup =
    status === "at_pickup_point" || (site.seen && status !== "delivered" && status !== "returning");
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["orderNo"]) ?? barcode,
    status,
    rawStatus:
      current === null
        ? null
        : (text(current.event["eventDesc"]) ?? text(current.event["eventCode"])),
    delivered,
    deliveredAt: delivered && current !== null ? eventTime(current.event) : null,
    pickup,
    pickupPoint: pickup ? site.name : null,
    url: publicUrl(barcode),
    history: newestFirst(history),
    raw,
  });
}
