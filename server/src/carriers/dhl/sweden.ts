import {
  snapshot,
  TransientError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  asArray,
  asObject,
  isObject,
  isoTime,
  readJson,
  ruleFieldsStatus,
  text,
  type Json,
  type ParcelStatus,
} from "../../plugin/api.js";
import { publicTrackingUrl } from "./constants.js";

/** DHL Freight Sweden's public shipment lookup. It accepts ten-character codes only. */
export const SWEDEN_HOST = "hamta.dhl.com";
const SWEDEN_URL = `https://${SWEDEN_HOST}/api/v1/shipment`;
const CODE_LENGTH = 10;

const HOME_METHODS = new Set(["HOME_DELIVERY", "RETURN_HOME_DELIVERY", "RETURN_SERVICEPOINT"]);

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

export function swedenShaped(code: string): boolean {
  return code.length === CODE_LENGTH && /^[A-Z0-9]+$/.test(code);
}

/** One request for every code; a 404 means none of them is a Freight Sweden shipment. */
export async function fetchSweden(
  deps: Deps,
  codes: readonly string[],
): Promise<Map<string, Json>> {
  const shaped = codes.filter(swedenShaped);
  const found = new Map<string, Json>();
  if (shaped.length === 0) {
    return found;
  }
  const url = new URL(SWEDEN_URL);
  for (const code of shaped) {
    url.searchParams.append("ids", code);
  }
  const response = await deps.http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return found;
  }
  if (response.status !== 200) {
    throw new TransientError(`DHL Freight Sweden answered HTTP ${response.status}.`);
  }
  for (const item of asArray(readJson(response, "DHL Freight Sweden"))) {
    const code = text(asObject(item)["trackingNumber"]);
    if (code !== null && isObject(item) && shaped.includes(code)) {
      found.set(code, item);
    }
  }
  return found;
}

const codes = (event: Json) => [event["statusCode"], event["reasonCode"]] as const;

/**
 * An event's status code and reason code (with whether the method is a home delivery) through
 * the shared DHL table, which also knows the service's own hand-over rule.
 */
function mapEvent(event: Json, method: string | null): ParcelStatus | null {
  const [status, reason] = codes(event);
  if (typeof status !== "number") {
    return null;
  }
  return ruleFieldsStatus("dhl", {
    swedenStatus: String(status),
    ...(typeof reason === "number" ? { swedenReason: String(reason) } : {}),
    ...(method === null ? {} : { delivery: HOME_METHODS.has(method) ? "home" : "servicepoint" }),
  });
}

/** The hand-over to the recipient: the only event the table reads as delivered. */
const isHandover = (event: Json, method: string | null): boolean =>
  mapEvent(event, method) === "delivered";

/** The shipment flags outrank the events, as on the service's own status card. */
function overall(
  raw: Json,
  events: readonly Json[],
  method: string | null,
  report: (key: string) => void,
): ParcelStatus {
  if (raw["isCollected"] === true) {
    return "delivered";
  }
  if (raw["isTimeout"] === true) {
    return "returning";
  }
  if (raw["isTerminated"] === true) {
    return "problem";
  }
  if (raw["isReadyForCollection"] === true) {
    return "at_pickup_point";
  }
  const newest = events.at(-1);
  if (newest === undefined) {
    return "registered";
  }
  const status = mapEvent(newest, method);
  if (status === null) {
    const [code, reason] = codes(newest);
    report(`sweden:${String(code)}/${String(reason)}`);
  }
  // Without the collected flag a hand-over event is not trusted on its own.
  return status === null || status === "delivered" ? "in_transit" : status;
}

function party(raw: Json, type: string): string | null {
  const found = asArray(raw["parties"]).find((p) => asObject(p)["type"] === type);
  return text(asObject(found)["name"]);
}

export function normalizeSweden(deps: Deps, code: string, raw: Json): ParcelSnapshot {
  const method = text(raw["deliveryMethod"]);
  const events = asArray(raw["events"])
    .filter(isObject)
    .sort((a, b) => (text(a["occuredAtTime"]) ?? "").localeCompare(text(b["occuredAtTime"]) ?? ""));
  const status = overall(raw, events, method, (key) => {
    deps.reportUnknown("status_code", key);
  });
  const delivered = status === "delivered";
  const handover = events.findLast((e) => isHandover(e, method)) ?? events.at(-1);
  const pickup = method !== null && !HOME_METHODS.has(method);
  const history: SnapshotEvent[] = events.flatMap((event) => {
    const at = isoTime(event["occuredAtTime"], { naive: "utc", epoch: "ms" });
    const rawStatus = text(event["eventText"]);
    return at === null || rawStatus === null
      ? []
      : [{ at, rawStatus, status: mapEvent(event, method), location: null }];
  });
  return snapshot({
    carrier: "dhl",
    barcode: code,
    status,
    rawStatus: text(events.at(-1)?.["eventText"]),
    delivered,
    deliveredAt: delivered
      ? isoTime(handover?.["occuredAtTime"], { naive: "utc", epoch: "ms" })
      : null,
    pickup,
    pickupPoint: pickup ? text(asObject(raw["servicePoint"])["name"]) : null,
    url: publicTrackingUrl(code),
    sender: party(raw, "CZ"),
    receiver: party(raw, "CN"),
    history: history.reverse(),
    raw,
  });
}
