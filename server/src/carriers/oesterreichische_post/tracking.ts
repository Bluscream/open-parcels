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
  isObject,
  isoTime,
  mapStatus,
  normalizeKey,
  num,
  publicUrl,
  text,
  TRACKING_HOST,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = carrierPattern("oesterreichische_post");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

const QUERY = `query ShipmentPublic($id: String!) {
  einzelsendung(sendungsnummer: $id) {
    activeIdentityCode originalIdentityCode status weight branchkey
    estimatedDeliveryDate
    estimatedDelivery { startDate endDate startTime endTime }
    shipper { name }
    sendungsEvents { trackingStateKey trackingState text textEn timestamp eventPlaceName }
  }
}`;

const INVALID_CODE = "INVALID_ARGUMENT_IDENTITY_CODE";

function isInvalidCode(errors: unknown[]): boolean {
  return errors.some((error) => asObject(asObject(error)["extensions"])["code"] === INVALID_CODE);
}

/**
 * Looks one code up through the keyless GraphQL endpoint. Returns null for an unknown or not yet
 * scanned code and for a code the carrier calls malformed; neither is an error.
 */
export async function lookUp(
  http: PluginHttp,
  barcode: string,
  language: "de" | "en",
): Promise<Json | null> {
  const response = await http.request(
    new URL(`https://${TRACKING_HOST}/sendungen/sv/graphqlPublic`),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": language,
      },
      body: JSON.stringify({ query: QUERY, variables: { id: barcode } }),
    },
  );
  if (response.status !== 200 && response.status !== 400) {
    throw new TransientError(`Austrian Post tracking answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Austrian Post tracking did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("Austrian Post tracking did not answer with an object.");
  }
  const errors = payload["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    if (isInvalidCode(errors)) {
      return null;
    }
    throw new UnexpectedResponseError("Austrian Post tracking answered with GraphQL errors.");
  }
  if (response.status !== 200 || !isObject(payload["data"])) {
    throw new UnexpectedResponseError("Austrian Post tracking carried no data object.");
  }
  const shipment = payload["data"]["einzelsendung"];
  if (shipment === null || shipment === undefined) {
    return null;
  }
  if (!isObject(shipment)) {
    throw new UnexpectedResponseError("Austrian Post tracking returned an unexpected shipment.");
  }
  return shipment;
}

/** Joins the separate date and time of the estimate; a time that does not combine is dropped. */
function combine(date: unknown, time: unknown): string | null {
  const day = text(date);
  if (day === null) {
    return null;
  }
  const clock = text(time);
  if (clock !== null && !/[T ]/.test(day)) {
    const joined = isoTime(`${day}T${clock.length === 5 ? `${clock}:00` : clock}`);
    if (joined !== null) {
      return joined;
    }
  }
  return isoTime(day);
}

function readWindow(raw: Json): { plannedFrom: string | null; plannedTo: string | null } {
  const eta = asObject(raw["estimatedDelivery"]);
  const from = combine(eta["startDate"], eta["startTime"]);
  if (from === null) {
    return { plannedFrom: isoTime(raw["estimatedDeliveryDate"]), plannedTo: null };
  }
  const to = combine(eta["endDate"], eta["endTime"]);
  // The same instant twice is a point estimate, not a window.
  return { plannedFrom: from, plannedTo: to === from ? null : to };
}

interface Step extends SnapshotEvent {
  readonly key: string;
}

/** Events newest first, sorted by time; the wire order is not promised. */
function readSteps(raw: Json, map: (key: string) => SnapshotEvent["status"]): Step[] {
  const list = Array.isArray(raw["sendungsEvents"]) ? (raw["sendungsEvents"] as unknown[]) : [];
  const steps: Step[] = [];
  for (const entry of list) {
    const event = asObject(entry);
    const at = isoTime(event["timestamp"]);
    const key = normalizeKey(event["trackingStateKey"]);
    if (at === null || key === null) {
      continue;
    }
    const rawStatus =
      text(event["textEn"]) ?? text(event["text"]) ?? text(event["trackingState"]) ?? key;
    steps.push({ at, key, rawStatus, status: map(key), location: text(event["eventPlaceName"]) });
  }
  return steps.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Turns one shipment into a snapshot; `report` receives unmapped state keys. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const reported = new Set<string>();
  const map = (key: string) => {
    const status = mapStatus(key);
    if (status === null && !reported.has(key)) {
      reported.add(key);
      report(key);
    }
    return status;
  };
  const steps = readSteps(raw, map);
  const code = text(raw["activeIdentityCode"]) ?? text(raw["originalIdentityCode"]) ?? barcode;
  // A known number with no scans yet is waiting for its first event.
  const key = steps[0]?.key ?? "PENDING_INFORMATION";
  const status = steps[0]?.status ?? mapStatus(key);
  const delivered = status === "delivered";
  const window = readWindow(raw);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: text(raw["status"]) ?? key,
    delivered,
    deliveredAt: delivered ? (steps.find((s) => s.status === "delivered")?.at ?? null) : null,
    plannedFrom: delivered ? null : window.plannedFrom,
    plannedTo: delivered ? null : window.plannedTo,
    pickup: status === "at_pickup_point",
    pickupPoint: text(raw["branchkey"]),
    url: publicUrl(code),
    sender: text(asObject(raw["shipper"])["name"]),
    weightKg: num(raw["weight"]),
    history: steps.map(({ at, rawStatus, status: mapped, location }) => ({
      at,
      rawStatus,
      status: mapped,
      location,
    })),
    raw,
  });
}
