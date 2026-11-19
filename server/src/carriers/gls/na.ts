import {
  asArray as asList,
  asObject,
  epoch,
  isObject,
  isoTime as kitIsoTime,
  joinParts,
  num,
  parseJsonBody,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import { CARRIER_ID, compactPostcode, latestHistory, mapGls, publicUrl, text } from "./shared.js";

export const US_HOST = "connect.gls-us.com";
export const CA_HOST = "web.gls-canada.com";

/**
 * North American timestamps carry no offset. They are read as UTC, the way the carrier's own
 * pages compare them; .NET's placeholder years mean "no date".
 */
function naTime(value: unknown): string | null {
  const raw = text(value);
  if (raw === null || /^(0001|1900)-/.test(raw)) {
    return null;
  }
  return kitIsoTime(raw.replace(" ", "T"), { naive: "utc" });
}

/** A status text, collapsed, with a scan's variable tail (`… - DELIVERY SCHED FOR …`) cut. */
function mapText(value: string | null): ReturnType<typeof mapGls> {
  if (value === null) {
    return null;
  }
  const collapsed = value.replace(/\s+/g, " ").trim();
  return mapGls(null, collapsed) ?? mapGls(null, collapsed.split(" - ")[0] ?? null);
}

async function getJson(http: PluginHttp, url: URL, init: Parameters<PluginHttp["request"]>[1]) {
  const response = await http.request(url, init);
  if (response.status !== 200) {
    return { status: response.status, body: null };
  }
  const body = parseJsonBody(response.body);
  if (!isObject(body)) {
    throw new UnexpectedResponseError(`GLS answered ${url.hostname} without a JSON object.`);
  }
  return { status: 200, body };
}

const sameNumber = (shipment: Json, barcode: string): boolean =>
  text(shipment["trackingNumber"])?.toUpperCase() === barcode.toUpperCase();

/** The newest record for the number: one number can have several (a return and its resend). */
export function newestUsShipment(raw: Json, barcode: string): Json | null {
  const matching = asList(raw["shipments"])
    .filter(isObject)
    .filter((shipment) => sameNumber(shipment, barcode));
  const recency = (shipment: Json): number => {
    const events = asList(shipment["transitDetails"])
      .filter(isObject)
      .map((detail) => epoch(naTime(detail["eventDateTime"])));
    const latest = Math.max(0, ...events);
    return latest > 0
      ? latest
      : epoch(naTime(shipment["deliveryDate"]) ?? naTime(shipment["shipDate"]));
  };
  let best: Json | null = null;
  for (const shipment of matching) {
    if (best === null || recency(shipment) >= recency(best)) {
      best = shipment;
    }
  }
  return best;
}

/** The keyless public US lookup, by number alone. 204 is the carrier's "not found". */
export async function lookUpUs(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${US_HOST}/api/public/tracking/TrackShipmentSummariesByTrackingNumbers`,
  );
  const response = await http.request(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-language": "en-US",
      "content-type": "application/json",
    },
    body: JSON.stringify({ trackingNumbers: barcode, isFreight: false }),
  });
  if (response.status === 204) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`GLS US answered HTTP ${response.status}.`);
  }
  const body = parseJsonBody(response.body);
  if (!isObject(body)) {
    throw new UnexpectedResponseError("GLS US answered without a JSON object.");
  }
  return newestUsShipment(body, barcode);
}

/** A status the table does not know is derived from what the dates prove. */
function deriveUs(shipment: Json, events: readonly SnapshotEvent[]): SnapshotEvent["status"] {
  if (naTime(shipment["deliveryDate"]) !== null) {
    return "delivered";
  }
  if (events.length > 0) {
    return "in_transit";
  }
  return naTime(shipment["shipDate"]) === null ? null : "registered";
}

export function usSnapshot(
  shipment: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = latestHistory(
    asList(shipment["transitDetails"])
      .filter(isObject)
      .flatMap((detail) => {
        const at = naTime(detail["eventDateTime"]);
        const rawStatus = text(detail["eventDetails"]);
        return at === null || rawStatus === null
          ? []
          : [{ at, rawStatus, status: mapText(rawStatus)?.status ?? null, location: null }];
      }),
  );
  const rawStatus = text(shipment["status"]);
  const mapped = mapText(rawStatus);
  if (rawStatus !== null && mapped === null) {
    report(rawStatus);
  }
  const status = mapped?.status ?? deriveUs(shipment, events);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(shipment["trackingNumber"]), barcode),
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered ? (naTime(shipment["deliveryDate"]) ?? events[0]?.at ?? null) : null,
    url: publicUrl(barcode),
    history: events,
    raw: shipment,
  });
}

function caShipment(body: Json | null, barcode: string): Json | null {
  const shipment = asList(body?.["shipments"])
    .filter(isObject)
    .find((entry) => sameNumber(entry, barcode));
  if (shipment === undefined) {
    return null;
  }
  const name = text(asObject(shipment["currentStatus"])["name"]);
  // NORECORD is Canada's HTTP 200 "no such parcel".
  return name?.toUpperCase() === "NORECORD" ? null : shipment;
}

/**
 * The Canadian lookup: the postcode route first (richer), the number-only route when GLS refuses
 * the postcode route for this code. Server errors never fall back.
 */
export async function lookUpCa(
  http: PluginHttp,
  barcode: string,
  postcode: string,
): Promise<Json | null> {
  const headers = { accept: "application/json", "accept-language": "en-CA" };
  const code = encodeURIComponent(barcode);
  const zip = encodeURIComponent(compactPostcode(postcode).toUpperCase());
  const detailed = await getJson(http, new URL(`https://${CA_HOST}/api/tracking/${zip}/${code}`), {
    headers,
  });
  if (detailed.status === 200) {
    return caShipment(detailed.body, barcode);
  }
  if (![401, 403, 404].includes(detailed.status)) {
    throw new TransientError(`GLS Canada answered HTTP ${detailed.status}.`);
  }
  const basic = await getJson(http, new URL(`https://${CA_HOST}/api/tracking/${code}`), {
    headers,
  });
  if (basic.status !== 200) {
    throw new TransientError(`GLS Canada answered HTTP ${basic.status}.`);
  }
  return caShipment(basic.body, barcode);
}

function party(value: unknown): string | null {
  if (typeof value === "string") {
    return text(value);
  }
  const entry = asObject(value);
  return (
    text(entry["name"]) ??
    joinParts(text(entry["city"]), text(entry["provinceCode"]), text(entry["countryCode"]))
  );
}

export function caSnapshot(
  shipment: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = latestHistory(
    asList(shipment["parcels"])
      .filter(isObject)
      .flatMap((parcel) => asList(parcel["activities"]).filter(isObject))
      .flatMap((activity) => {
        const at = naTime(activity["activityDate"]);
        const rawStatus = text(activity["status"]);
        return at === null || rawStatus === null
          ? []
          : [{ at, rawStatus, status: mapText(rawStatus)?.status ?? null, location: null }];
      }),
  );
  const current = asObject(shipment["currentStatus"]);
  const rawStatus = text(current["name"]);
  const mapped = mapText(rawStatus);
  if (rawStatus !== null && mapped === null) {
    report(rawStatus);
  }
  const status = mapped?.status ?? null;
  const delivered = status === "delivered";
  const number = text(shipment["trackingNumber"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(number, barcode),
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered ? naTime(current["date"]) : null,
    url: `https://gls-group.com/CA/en/send-and-receive/track-a-shipment/?match=${encodeURIComponent(number)}`,
    sender: party(shipment["sender"]),
    receiver: party(shipment["consignee"]),
    weightKg: num(shipment["totalWeight"]),
    history: events,
    raw: shipment,
  });
}
