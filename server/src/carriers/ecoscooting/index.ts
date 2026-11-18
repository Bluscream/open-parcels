import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type PluginHttp,
  asObject,
  num,
  objects,
  readObject,
  text,
  type Json,
  epochIso,
  isoTime,
  newestFirst,
  expectStatus,
  lookUpStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
  type StatusTable,
} from "../../plugin/api.js";

const CARRIER_ID = "ecoscooting";
/** Ecoscooting's own tracking page reads from its parent network's public link gateway. */
const HOST = "de-link.cainiao.com";
/** The one error code for "no such reference", indistinguishable from "not available yet". */
const NOT_FOUND = "P-011-0201-00-00-502";
const HOUR_MS = 3_600_000;

const STATUSES: StatusTable = {
  CREATE: "registered",
  LABEL_CREATED: "registered",
  CREATE_ORDER_CES: "registered",
  GTMS_ACCEPT: "in_transit",
  SL_ACCEPT: "in_transit",
  PU_PICKUP_SUCCESS: "in_transit",
  TD_TRANSWH_OUTBOUND: "in_transit",
  TD_TRANS_ARRIVE_C: "in_transit",
  IN_TRANSIT: "in_transit",
  COMMON_INTRANSIT: "in_transit",
  PARTNER_OUTBOUND: "in_transit",
  TRANSFER_ARRIVE: "in_transit",
  TRANSFER_DEPART: "in_transit",
  SC_INBOUND: "in_transit",
  SC_OUTBOUND: "in_transit",
  GTMS_DO_DEPART: "out_for_delivery",
  LM_DELIVERY_DEPART: "out_for_delivery",
  GTMS_STA_SIGNED: "at_pickup_point",
  PUDO_DELIVERY: "at_pickup_point",
  GTMS_PUDO_INBOUND: "at_pickup_point",
  PUDO_INBOUND: "at_pickup_point",
  GTMS_SIGNED: "delivered",
  LM_SIGN_SUCCESS: "delivered",
  GTMS_PUDO_SIGNED: "delivered",
  PUDO_SIGN_SUCCESS: "delivered",
  GTMS_DEL_FAILURE: "problem",
  LM_DELIVERY_FAILURE: "problem",
  LM_PARCEL_EXCEPTION: "problem",
  GTMS_PUDO_OVERDUE: "returning",
  PUDO_OVERDUE: "returning",
  GTMS_SIGN_FAILURE: "returning",
  LM_UNREACHABLE_RETURN: "returning",
};

const PLAUSIBLE = /^[A-Z0-9]{8,40}$/;

/** Every code of the return leg starts with `RT_`. */
function statusOf(code: string | null): ParcelStatus | null {
  const key = code?.toUpperCase() ?? null;
  return key?.startsWith("RT_") === true ? "returning" : lookUpStatus(STATUSES, key);
}

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const body = new URLSearchParams({
    logistics_interface: JSON.stringify({ mailNo: code, locale: "en_US", role: "endUser" }),
    msg_type: "CN_OVERSEA_LOGISTICS_INQUIRY_TRACKING",
    logistic_provider_id: "DISTRIBUTOR_30250031",
    data_digest: "x",
    to_code: "CNL_EU",
  });
  const response = await http.request(new URL(`https://${HOST}/gateway/link.do`), {
    method: "POST",
    headers: { accept: "application/json" },
    body,
  });
  expectStatus(response, "Ecoscooting tracking");
  const payload = readObject(response, "Ecoscooting tracking");
  if (payload["success"] === "true" || payload["success"] === true) {
    const reported = text(asObject(payload["packageParam"])["trackingNumber"]);
    if (reported !== null && reported.toUpperCase() !== code) {
      throw new UnexpectedResponseError("Ecoscooting answered for a different reference.");
    }
    return payload;
  }
  if (payload["errorCode"] === NOT_FOUND) {
    return null;
  }
  throw new UnexpectedResponseError("Ecoscooting answered with an unknown error envelope.");
}

const eventTime = (event: Json): string | null =>
  isoTime(event["opTimestamp"], { naive: "reject", epoch: "auto", epochStrings: true });

function history(events: readonly Json[]): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = eventTime(event);
    const code = text(event["actionCode"]);
    const rawStatus = text(event["statusName"]) ?? text(event["description"]) ?? code;
    if (at !== null && rawStatus !== null) {
      result.push({ at, rawStatus, status: statusOf(code), location: null });
    }
  }
  return newestFirst(result);
}

/** The end of the delivery day, in the fixed offset (whole hours) the event reports. */
function endOfDeliveryDay(event: Json): string | null {
  const at = eventTime(event);
  const offset = num(event["timezone"]);
  if (at === null || offset === null || !Number.isInteger(offset)) {
    return null;
  }
  const local = new Date(Date.parse(at) + offset * HOUR_MS);
  local.setUTCHours(23, 59, 59, 0);
  return epochIso(local.getTime() - offset * HOUR_MS, "auto");
}

function pickupPoint(raw: Json): string | null {
  const station = asObject(raw["popStationParam"]);
  const parts = [station["stationName"], station["detailAddress"]]
    .flatMap((value) => (text(value) ?? "").split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.toUpperCase() !== "NAN");
  return parts.length === 0 ? null : parts.join(", ");
}

function weightKg(raw: Json): number | null {
  const weight = asObject(asObject(raw["packageParam"])["dimWeight"]);
  const grams = num(weight["weight"]);
  return grams !== null && text(weight["weightUnit"])?.toLowerCase() === "g"
    ? Math.round(grams) / 1000
    : null;
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  // Newest first.
  const events = objects(raw["statuses"]);
  const newest = events[0] ?? {};
  const code = text(newest["actionCode"]);
  let status = statusOf(code);
  if (code !== null && status === null) {
    report(code);
  }
  status ??=
    events.map((event) => statusOf(text(event["actionCode"]))).find((s) => s !== null) ?? null;
  const first = (wanted: ParcelStatus): Json | undefined =>
    events.find((event) => statusOf(text(event["actionCode"])) === wanted);
  const departed = status === "out_for_delivery" ? first("out_for_delivery") : undefined;
  const signed = status === "delivered" ? first("delivered") : undefined;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(newest["statusName"]) ?? text(newest["description"]) ?? code,
    deliveredAt: signed === undefined ? null : eventTime(signed),
    plannedFrom: departed === undefined ? null : eventTime(departed),
    plannedTo: departed === undefined ? null : endOfDeliveryDay(departed),
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(raw),
    url: `https://www.ecoscooting.com/tracking/${encodeURIComponent(barcode)}`,
    weightKg: weightKg(raw),
    history: history(events),
    raw,
  });
}

async function track(context: PluginContext<unknown, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** Ecoscooting (Spain): last-mile delivery for marketplace parcels, public tracking by code. */
export const ecoscooting = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "Ecoscooting",
  countries: ["ES"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
