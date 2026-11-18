import { mapLocal, text, type Json, type ParcelStatus } from "../_kit/json.js";

/** The parcel-level `status` string. Variants like `InTransit-xyz` fall back to their family. */
const STATUS: Readonly<Record<string, ParcelStatus>> = {
  HalfAccepted: "registered",
  FullAccepted: "in_transit",
  InTransit: "in_transit",
  InTransitAlert: "problem",
  FullProgress: "out_for_delivery",
  FullProgressAlert: "problem",
  HalfDelivered: "problem",
  ReadyPickup: "at_pickup_point",
  Available_for_pickup_by: "at_pickup_point",
  Delivered: "delivered",
};

/** An event code outranks its type: one type covers several outcomes. */
const EVENT_CODE: Readonly<Record<string, ParcelStatus>> = {
  "3000": "registered",
  "1466": "delivered",
  "0174": "out_for_delivery",
  "0500": "out_for_delivery",
  "1701": "at_pickup_point",
  "0156": "at_pickup_point",
  "2407": "at_pickup_point",
  "1419": "returning",
  "1481": "returning",
  "2600": "returning",
  "1303": "returning",
  "3001": "returning",
  "3002": "returning",
  "1100": "problem",
};

const IN_TRANSIT_TYPES = [
  "ARRIVALINCANADA",
  "CONTAINER",
  "INCOMING",
  "INDUCTION",
  "INFOTID",
  "REVIEWCOMPLETE",
  "VEHICLEINFO",
  "PRRECEIVED",
  "INFOCONT",
  "DISPATCH",
  "TOCUST",
  "FROMCUST",
  "INFO",
  "TORETAIL",
] as const;

/** Event types, upper-cased. A failed attempt counts as a problem for a household. */
const EVENT_TYPE: Readonly<Record<string, ParcelStatus>> = {
  ...Object.fromEntries(IN_TRANSIT_TYPES.map((type) => [type, "in_transit" as const])),
  OUT: "out_for_delivery",
  ATTEMPTED: "problem",
  DETENTION: "problem",
  FORREVIEW: "problem",
  RTSLABELPROC: "returning",
  DELIVERED: "delivered",
  SIGNATURE: "delivered",
};

export const DELIVERED_EVENT_CODE = "1466";

export function mapParcelStatus(value: string | null): ParcelStatus | null {
  if (value === null) {
    return null;
  }
  return mapLocal(STATUS, value) ?? mapLocal(STATUS, value.split("-")[0] ?? value);
}

export function mapEvent(event: Json): ParcelStatus | null {
  const code = text(event["cd"]);
  return (
    mapLocal(EVENT_CODE, code) ?? mapLocal(EVENT_TYPE, text(event["type"])?.toUpperCase() ?? null)
  );
}

/**
 * The status string first; when it does not map, the newest event that does. A parcel on its
 * way back is `returning` whatever its status string says, unless it is already delivered.
 */
export function resolveStatus(
  detail: Json,
  newestFirst: readonly Json[],
  report: (code: string) => void,
): ParcelStatus | null {
  if (detail["delivered"] === true) {
    return "delivered";
  }
  const raw = text(detail["status"]);
  let status = mapParcelStatus(raw);
  if (status === null) {
    status = newestFirst.map(mapEvent).find((mapped) => mapped !== null) ?? null;
    if (status === null && raw !== null) {
      report(raw);
    }
  }
  const returned = detail["returnedToSender"] === true || detail["returnPinIndicator"] === true;
  return returned && status !== "delivered" ? "returning" : status;
}
