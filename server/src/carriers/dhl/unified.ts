import {
  SignInRejectedError,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  objects,
  num,
  parseJsonBody,
  isoTime,
  epoch,
  rulesStatus,
} from "../../plugin/api.js";
import { publicTrackingUrl, UNIFIED_URL } from "./constants.js";
import { asObject, asString, type Json } from "./util.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

const KG_PER_UNIT: Readonly<Record<string, number>> = {
  kg: 1,
  g: 0.001,
  lb: 0.45359237,
  lbs: 0.45359237,
  oz: 0.028349523125,
};

/**
 * DHL's official shipment tracking API, with the user's own key. One request per code. Returns
 * null when DHL has no shipment for it. A rejected key is the user's credential, so it is the
 * one failure here that asks for a new sign-in.
 */
export async function fetchUnified(deps: Deps, apiKey: string, code: string): Promise<Json | null> {
  const url = new URL(UNIFIED_URL);
  url.searchParams.set("trackingNumber", code);
  url.searchParams.set("language", "en");
  const response = await deps.http.request(url, {
    headers: { "DHL-API-Key": apiKey, accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SignInRejectedError("DHL rejected the API key.");
  }
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`The DHL tracking API answered HTTP ${response.status}.`);
  }
  const body = asObject(parseJsonBody(response.body));
  if (body === null) {
    throw new UnexpectedResponseError("The DHL tracking API did not answer with an object.");
  }
  const shipments = objects(body["shipments"]);
  if (shipments.length === 0) {
    return null;
  }
  // Only the shipment that is this code: taking another one would file its history under it.
  const compact = (value: string): string => value.replace(/\s+/g, "").toUpperCase();
  const match = shipments.find((s) => {
    const id = asString(s["id"]);
    return id !== null && compact(id) === compact(code);
  });
  if (match === undefined) {
    throw new UnexpectedResponseError("The DHL tracking API answered without the asked code.");
  }
  return match;
}

function mapCode(deps: Deps, status: Json): SnapshotEvent["status"] {
  const code = asString(status["statusCode"]);
  if (code === null) {
    return null;
  }
  const mapped = rulesStatus("dhl", { code });
  if (mapped === null) {
    deps.reportUnknown("unified_status_code", code);
  }
  return mapped?.status ?? null;
}

function weightKg(details: Json | null): number | null {
  const weight = asObject(details?.["weight"]);
  const value = num(weight?.["value"], { strings: false });
  const unit = (asString(weight?.["unitText"]) ?? "").trim().toLowerCase();
  const factor = KG_PER_UNIT[unit];
  return value === null || factor === undefined ? null : Math.round(value * factor * 1000) / 1000;
}

function location(event: Json): string | null {
  const address = asObject(asObject(event["location"])?.["address"]);
  return asString(address?.["addressLocality"]);
}

/** `code` is the number the user entered; DHL may answer with another id, kept in `raw`. */
export function normalizeUnified(deps: Deps, code: string, shipment: Json): ParcelSnapshot {
  const status = asObject(shipment["status"]) ?? {};
  const history: SnapshotEvent[] = [];
  for (const event of objects(shipment["events"])) {
    // An event time without an offset is local to a place we cannot resolve; it is dropped
    // rather than relabelled as UTC.
    const at = isoTime(event["timestamp"], { naive: "reject" });
    if (at !== null) {
      history.push({
        at,
        status: mapCode(deps, event),
        rawStatus: asString(event["status"]) ?? asString(event["statusCode"]) ?? "",
        location: location(event),
      });
    }
  }
  history.sort((a, b) => epoch(a.at) - epoch(b.at));
  const mapped = mapCode(deps, status);
  const delivered = asString(status["statusCode"]) === "delivered";
  const frame = asObject(shipment["estimatedDeliveryTimeFrame"]);
  const eta = isoTime(shipment["estimatedTimeOfDelivery"], { naive: "reject" });
  const from = isoTime(frame?.["estimatedFrom"], { naive: "reject" }) ?? eta;
  const to = isoTime(frame?.["estimatedThrough"], { naive: "reject" }) ?? eta;
  const deliveredAt = delivered
    ? (history.findLast((e) => e.status === "delivered")?.at ??
      isoTime(status["timestamp"], { naive: "reject" }))
    : null;
  return snapshot({
    carrier: "dhl",
    barcode: code,
    status: mapped,
    rawStatus: asString(status["status"]) ?? asString(status["statusCode"]),
    delivered,
    deliveredAt,
    plannedFrom: delivered ? null : from,
    plannedTo: delivered ? null : to,
    url: publicTrackingUrl(code),
    weightKg: weightKg(asObject(shipment["details"])),
    history,
    raw: shipment,
  });
}
