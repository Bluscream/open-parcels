import { createHmac } from "node:crypto";
import {
  asArray as asList,
  asObject,
  carrierKey,
  isObject,
  num,
  parseJsonBody,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type PluginLogger,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { CARRIER_ID, compactPostcode, isoTime, latestHistory, mapGls, text } from "./shared.js";

export const ES_HOST = "api.consignee.gls-spain.es";
/** The route as signed: without the `/api/v5` prefix the URL carries. */
const FIND_PATH = "/expeditions/find";

/**
 * The request stamp the service expects: ISO 8601 UTC with milliseconds. It rejects stamps far
 * from its own clock, so every attempt is stamped and signed anew.
 */
export function requestStamp(now: Date): string {
  return now.toISOString();
}

/**
 * HMAC-SHA256 (lowercase hex) over method, route and stamp, one per line, keyed with the fixed
 * value the consumer website signs with (in the shared rules).
 */
export function signRequest(key: string, method: string, path: string, stamp: string): string {
  return createHmac("sha256", key).update(`${method}\n${path}\n${stamp}`).digest("hex");
}

/**
 * The signed national lookup for Spain and Portugal, keyed on number and delivery postcode
 * together. Only the carrier's own `notFound` answer means "no such parcel"; a rejected stamp,
 * a rejected signature or a non-JSON page stops the run.
 */
export async function lookUpEs(
  http: PluginHttp,
  logger: PluginLogger,
  now: Date,
  barcode: string,
  postcode: string,
): Promise<Json | null> {
  const stamp = requestStamp(now);
  const response = await http.request(new URL(`https://${ES_HOST}/api/v5${FIND_PATH}`), {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-language": "en_US",
      "content-type": "application/json; charset=utf-8",
      "mygls-agent": carrierKey("gls", "es_agent"),
      "x-timestamp": stamp,
      "x-signature": signRequest(carrierKey("gls", "es_signing_key"), "POST", FIND_PATH, stamp),
    },
    body: JSON.stringify({
      find: {
        reference: barcode,
        destination: { address: { postalCode: compactPostcode(postcode) } },
      },
    }),
  });
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(`GLS Spain answered HTTP ${response.status} without JSON.`);
  }
  const error = asObject(payload["error"]);
  if (response.status === 404 && error["details"] === "notFound") {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    logger.warn(
      { status: response.status, error: text(error["name"]) },
      response.status === 401
        ? "GLS Spain rejected the request stamp; check this machine's clock."
        : "GLS Spain rejected its own website's request signature.",
    );
    throw new TransientError(`GLS Spain refused the signed request (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`GLS Spain answered HTTP ${response.status}.`);
  }
  const found = payload["found"];
  if (!isObject(found)) {
    throw new UnexpectedResponseError("GLS Spain answered 200 without a shipment.");
  }
  return found;
}

/**
 * `incidence` covers ordinary missed deliveries and real problems alike. Only a diversion to a
 * GLS Point (its sentence says so) keeps the parcel moving; every other incidence is a problem.
 */
function mapEs(code: string | null, sentence: string | null): ReturnType<typeof mapGls> {
  if (code === "incidence") {
    const read = mapGls(null, sentence?.replace(/\s+/g, " ").trim() ?? null);
    return read?.status === "in_transit" ? read : mapGls(code);
  }
  return mapGls(code);
}

/** History rows, de-duplicated: the service repeats rows verbatim. */
function rows(found: Json): Json[] {
  const seen = new Set<string>();
  return asList(found["tracking"])
    .filter(isObject)
    .filter((row) => {
      const identity = JSON.stringify([row["code"], row["description"], row["at"]]);
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
      return true;
    });
}

function history(scans: readonly Json[], zone: string): SnapshotEvent[] {
  return latestHistory(
    scans.flatMap((row) => {
      const at = isoTime(row["at"], zone);
      const code = text(row["code"]);
      const description = text(row["description"]);
      const rawStatus = description ?? code;
      return at === null || rawStatus === null
        ? []
        : [{ at, rawStatus, status: mapEs(code, description)?.status ?? null, location: null }];
    }),
  );
}

const PICKUP_SCANS = new Set(["deliveredOnParcel", "receivedOnParcel"]);

/** The GLS Point counts only once a scan names it; `parcelShop` is set on more shipments. */
function pickupPoint(found: Json, scans: readonly Json[]): string | null {
  const shop = found["parcelShop"];
  if (!isObject(shop) || !scans.some((row) => PICKUP_SCANS.has(text(row["code"]) ?? ""))) {
    return null;
  }
  return text(shop["name"]);
}

export function esUrl(country: "ES" | "PT", barcode: string, postcode: string): string {
  const host = country === "PT" ? "mygls.gls-portugal.pt" : "mygls.gls-spain.es";
  const language = country === "PT" ? "pt" : "es";
  return `https://${host}/e/${encodeURIComponent(barcode)}/${encodeURIComponent(compactPostcode(postcode))}/${language}`;
}

/** Turns one Spanish or Portuguese shipment into a snapshot, under the code the user tracks. */
export function esSnapshot(
  found: Json,
  ids: { barcode: string; postcode: string; country: "ES" | "PT" },
  report: (code: string) => void,
): ParcelSnapshot {
  const state = asObject(found["state"]);
  const code = text(state["code"]);
  const scans = rows(found);
  const events = history(scans, ids.country === "PT" ? "Europe/Lisbon" : "Europe/Madrid");
  const mapped = mapEs(code, text(state["description"]));
  // `stored` has no milestone of its own; like any unmapped state it takes the newest scan's.
  if (code !== null && mapped === null && code !== "stored") {
    report(code);
  }
  const status = mapped?.status ?? events.find((event) => event.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const deliveredScan = events.find((event) => event.status === "delivered");
  return snapshot({
    carrier: CARRIER_ID,
    barcode: ids.barcode,
    status,
    rawStatus: code,
    delivered,
    deliveredAt: delivered ? (deliveredScan?.at ?? events[0]?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(found, scans),
    url: esUrl(ids.country, ids.barcode, ids.postcode),
    sender: text(asObject(found["sender"])["name"]),
    weightKg: num(asObject(found["attributes"])["weight"], { decimalComma: true }),
    history: events,
    raw: found,
  });
}
