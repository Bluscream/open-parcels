import {
  asArray as asList,
  asObject,
  echoRef,
  expectStatus,
  isObject,
  readJson,
  snapshot,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  CARRIER_ID,
  compactPostcode,
  isoTime,
  latestHistory,
  mapGls,
  NL_HOST,
  text,
} from "./shared.js";

const NL_ZONE = "Europe/Amsterdam";

/**
 * The Dutch national tracking: one keyless GET keyed on parcel number and delivery postcode.
 * 204 means GLS does not know the parcel (yet); that is a normal "not found".
 */
export async function lookUpNl(
  http: PluginHttp,
  barcode: string,
  postcode: string,
): Promise<Json | null> {
  const url = new URL(
    `https://${NL_HOST}/api/tracktrace/v1/${encodeURIComponent(barcode)}/postalcode/${encodeURIComponent(compactPostcode(postcode))}/details/nl-NL`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 204 || response.status === 404) {
    return null;
  }
  expectStatus(response, "GLS Netherlands", 200);
  if (response.body.trim() === "") {
    return null;
  }
  const payload = readJson(response, "GLS Netherlands");
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("GLS Netherlands answered with something not a parcel.");
  }
  return payload;
}

function stateCode(value: unknown): string | null {
  return typeof value === "number" && Number.isInteger(value) ? `state:${value}` : null;
}

function scans(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asList(raw["scans"])) {
    const scan = asObject(entry);
    const at = isoTime(scan["dateTime"], NL_ZONE);
    const code = stateCode(scan["state"]);
    const rawStatus = text(scan["eventReasonDescr"]) ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    events.push({ at, rawStatus, status: mapGls(code)?.status ?? null, location: null });
  }
  return latestHistory(events);
}

function pickupPoint(raw: Json): string | null {
  const shop = asObject(raw["deliveryScanInfo"])["parcelShop"];
  return isObject(shop) ? text(shop["name"]) : text(shop);
}

function weight(raw: Json): number | null {
  const value = raw["weighedWeight"] ?? raw["suppliedWeight"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Turns one Dutch tracking result into a snapshot; `report` receives unmapped codes. */
export function nlSnapshot(
  raw: Json,
  barcode: string,
  postcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const code = stateCode(raw["state"]);
  const mapped = mapGls(code);
  if (code !== null && mapped === null) {
    report(code);
  }
  const scanInfo = asObject(raw["deliveryScanInfo"]);
  const status = mapped?.status ?? null;
  const delivered = scanInfo["isDelivered"] === true || status === "delivered";
  const eta = asObject(raw["deliveryStatus"]);
  const address = asObject(raw["addressInfo"]);
  const pickup =
    raw["isPickup"] === true || asObject(raw["deliveryListInfo"])["isParcelShop"] === true;
  const parcelNo = text(raw["parcelNo"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(parcelNo, barcode),
    status: delivered ? "delivered" : status,
    rawStatus: text(asObject(asList(raw["parcels"])[0])["lastStatus"]) ?? code,
    delivered,
    deliveredAt: delivered ? isoTime(scanInfo["dateTime"], NL_ZONE) : null,
    plannedFrom: delivered ? null : isoTime(eta["etaTimestampMin"], NL_ZONE),
    plannedTo: delivered ? null : isoTime(eta["etaTimestampMax"], NL_ZONE),
    pickup,
    pickupPoint: pickup ? pickupPoint(raw) : null,
    url: `https://www.gls-info.nl/tracking?trackid=${encodeURIComponent(parcelNo)}&zipcode=${encodeURIComponent(compactPostcode(postcode))}`,
    sender: text(asObject(address["from"])["name"]),
    receiver: text(asObject(address["to"])["name"]),
    weightKg: weight(raw),
    history: scans(raw),
    raw,
  });
}
