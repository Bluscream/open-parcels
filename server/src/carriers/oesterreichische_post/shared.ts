import {
  isoTime as kitIsoTime,
  num as kitNum,
  text as kitText,
  type ParcelStatus,
} from "../../plugin/api.js";

export const CARRIER_ID = "oesterreichische_post";
export const TRACKING_HOST = "api.post.at";

export { asObject, isObject, type Json } from "../../plugin/api.js";

/** Austrian Post's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Only real numbers; numeric strings stay text. */
export const num = (value: unknown): number | null => kitNum(value, { strings: false });

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/**
 * ISO 8601 for a carrier timestamp. Austrian Post stamps in local time and sometimes leaves the
 * offset off; such values are read as Vienna time, never as UTC. Numbers are epoch milliseconds;
 * other strings are read as `new Date()` reads them.
 */
export function isoTime(value: unknown): string | null {
  const raw = text(value);
  if (raw !== null && LOCAL_TIME.test(raw)) {
    return kitIsoTime(raw, { naive: { zone: "Europe/Vienna" }, keepFraction: true });
  }
  return kitIsoTime(raw ?? value, { naive: "runtime", epoch: "ms" });
}
/** The state keys arrive in camelCase; the vocabulary is written in UPPER_SNAKE. */
export function normalizeKey(key: unknown): string | null {
  const raw = text(key);
  return raw === null ? null : raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Local map until the shared rules carry an Austrian Post table: the carrier's complete tracking
 * state vocabulary. `DELIVERY_INTERUPTED` is the carrier's own spelling. `UNKNOWN` is left out on
 * purpose: seeing it means the vocabulary moved, so it should be reported.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  PENDING_INFORMATION: "registered",
  PARCEL_STAMP: "registered",
  AVISO: "registered",
  ALLES_POST: "registered",
  DELIVERY_HAND_OVER: "in_transit",
  IN_DISTRIBUTION: "in_transit",
  CUSTOMS_CLEARANCE: "in_transit",
  DELIVERY_IN_CUSTOMS: "in_transit",
  IN_DELIVERY: "out_for_delivery",
  NOTIFIED: "at_pickup_point",
  READY_FOR_PICK_UP: "at_pickup_point",
  READY_FOR_PICK_UP_STATION: "at_pickup_point",
  READY_FOR_PICK_UP_POINT: "at_pickup_point",
  READY_FOR_PICK_UP_BOX: "at_pickup_point",
  DELIVERED: "delivered",
  // Left at the agreed safe place; the carrier itself counts it as delivered.
  DELIVERY_PARKED: "delivered",
  DELIVERY_IN_RETURN: "returning",
  DELIVERY_DELAYED: "problem",
  DELIVERY_INTERUPTED: "problem",
  NOT_REACHABLE: "problem",
};

export function mapStatus(key: string | null): ParcelStatus | null {
  return key === null ? null : (STATUS_MAP[key] ?? null);
}

export function publicUrl(barcode: string): string {
  return `https://www.post.at/s/sendungsdetails?snr=${encodeURIComponent(barcode)}`;
}
