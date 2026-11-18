import {
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  asArray,
  asObject,
  isObject,
  mapLocal,
  num,
  parseJson,
  text,
  type Json,
  type ParcelStatus,
} from "../_kit/json.js";
import { parseLocal } from "../_kit/zoned.js";
import { publicTrackingUrl } from "./constants.js";

/** DHL eCommerce Iberia's public tracking (Spain and Portugal). */
export const IBERIA_HOST = "clientesparcel.dhl.es";
const IBERIA_URL = `https://${IBERIA_HOST}/LiveTracking.GTW/api/shipment-detail`;
/**
 * Scan times have no offset and the network spans the mainland, the Canaries and Portugal;
 * mainland time is the closest single answer.
 */
const ZONE = "Europe/Madrid";

const CODE_STATUS: Readonly<Record<string, ParcelStatus>> = {
  BS: "in_transit",
  HS: "in_transit",
  AS: "in_transit",
  ES: "in_transit",
  GT: "in_transit",
  DIA: "in_transit",
  EC: "in_transit",
  ZZZ: "in_transit",
  A: "out_for_delivery",
  IS: "at_pickup_point",
  NH: "problem",
  CR: "problem",
  CH: "problem",
  PE: "problem",
  FM: "problem",
  OH: "problem",
  FA: "problem",
  AI: "problem",
  RT: "returning",
  R: "delivered",
  PC: "delivered",
  RS: "delivered",
};

/** Scans without a code are told apart by their English wording only. */
const WORDING_STATUS: Readonly<Record<string, ParcelStatus>> = {
  "Shipment received at DHL Depot": "in_transit",
  "Arrived at": "in_transit",
  "In transit in": "in_transit",
  "Departed from": "in_transit",
  "Picked up": "in_transit",
};

/** Codes that put the parcel on its way to, or at, a ServicePoint. */
const PICKUP_CODES = new Set(["AS", "ES", "IS", "RS"]);

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

/** An empty number returns another parcel, so only plain alphanumeric codes are sent. */
export function iberiaShaped(code: string): boolean {
  return /^[A-Z0-9]{8,40}$/.test(code);
}

/** One code; null when Iberia does not know it (204), cannot parse it (409) or answers for another. */
export async function fetchIberia(deps: Deps, code: string): Promise<Json | null> {
  const url = new URL(IBERIA_URL);
  url.searchParams.set("number", code);
  const response = await deps.http.request(url, {
    headers: { accept: "application/json", "accept-language": "en-US" },
  });
  if ([204, 404, 409].includes(response.status)) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`DHL Iberia answered HTTP ${response.status}.`);
  }
  // The firewall answers a challenge page with 200.
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new UnexpectedResponseError("DHL Iberia answered with something other than JSON.");
  }
  const body = parseJson(response, "DHL Iberia");
  return isObject(body) && text(body["ExpeditionNumber"])?.toUpperCase() === code ? body : null;
}

function mapEvent(event: Json, report?: (key: string) => void): ParcelStatus | null {
  const code = text(event["Code"]);
  if (code !== null) {
    return mapLocal(CODE_STATUS, code, (c) => report?.(`iberia:${c}`));
  }
  if (event["SolutionCode"] === "DOC") {
    return "registered";
  }
  return mapLocal(WORDING_STATUS, text(event["Description"]), (c) => report?.(`iberia:${c}`));
}

function wording(event: Json): string | null {
  const description = text(event["Description"]);
  const town = text(event["Town"]);
  // Depot scans end in a preposition; the page completes them with the town.
  return description !== null && town !== null && / (at|in|from)$/.test(description)
    ? `${description} ${town}`
    : description;
}

function eventTime(event: Json): string | null {
  const date = text(event["Date"]);
  return date === null
    ? null
    : parseLocal(`${date} ${text(event["Time"]) ?? "00:00"}`, ZONE, "DMY");
}

export function normalizeIberia(deps: Deps, code: string, raw: Json): ParcelSnapshot {
  const report = (key: string): void => {
    deps.reportUnknown("status_code", key);
  };
  // Newest first on this back end.
  const events = asArray(raw["Tracking"]).filter(isObject);
  const newest = events[0];
  const mapped = events.map((event, index) => ({
    event,
    status: mapEvent(event, index === 0 ? report : undefined),
  }));
  const decided = mapped.find((m) => m.status !== null);
  let status: ParcelStatus | null = events.length === 0 ? "registered" : (decided?.status ?? null);
  // Movement after a return scan is the trip back to the sender.
  if (status === "in_transit" && events.some((e) => e["Code"] === "RT")) {
    status = "returning";
  }
  const delivered = status === "delivered";
  const pickup =
    raw["DeliveredInServicePoint"] === true ||
    events.some((e) => PICKUP_CODES.has(text(e["Code"]) ?? ""));
  const history: SnapshotEvent[] = mapped.flatMap(({ event, status: eventStatus }) => {
    const at = eventTime(event);
    const rawStatus = wording(event);
    return at === null || rawStatus === null
      ? []
      : [{ at, rawStatus, status: eventStatus, location: text(event["Town"]) }];
  });
  const weight = num(raw["Weight"]);
  return snapshot({
    carrier: "dhl",
    barcode: code,
    status,
    rawStatus: newest === undefined ? null : wording(newest),
    delivered,
    deliveredAt: delivered && decided !== undefined ? eventTime(decided.event) : null,
    pickup,
    pickupPoint: pickup ? text(asObject(raw["ServicePoint"])["Name"]) : null,
    url: publicTrackingUrl(code),
    weightKg: weight === null || weight <= 0 ? null : weight,
    history,
    raw,
  });
}
