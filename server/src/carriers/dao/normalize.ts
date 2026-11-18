import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import { asObject, num, objects, text, type Json } from "../../plugin/kit/json.js";
import { isoTime, newestFirst } from "../../plugin/kit/time.js";
import { lookUpStatus, type Status, type StatusTable } from "../../plugin/kit/track.js";

export const CARRIER_ID = "dao";
const ZONE = "Europe/Copenhagen";

/** The closed `statusType` list. `STATUS_INFO` is informational and maps to nothing. */
const TYPES: StatusTable = {
  STATUS_PROCESSING: "registered",
  STATUS_IN_TRANSIT: "in_transit",
  STATUS_RETURN: "returning",
  STATUS_ALERT: "problem",
};
const KNOWN_TYPES = new Set([...Object.keys(TYPES), "STATUS_OK", "STATUS_INFO"]);

/** Status codes that decide the status whatever type carries them (drop-off, on the way). */
const CODE_OVERRIDES: Readonly<Record<number, Status>> = {
  11: "in_transit",
  23: "in_transit",
  25: "in_transit",
  26: "in_transit",
};
/** Under `STATUS_OK`: ready for pickup, handed over. */
const OK_CODES: Readonly<Record<number, Status>> = { 32: "at_pickup_point", 51: "delivered" };
const KNOWN_CODES = new Set([1, 11, 12, 23, 25, 26, 32, 51]);

export interface Reports {
  readonly type: (key: string) => void;
  readonly code: (key: string) => void;
}

/**
 * Maps a status. `STATUS_OK` means the parcel arrived: at a pickup point when it has one, else
 * delivered, unless a known code says which.
 */
export function mapStatus(
  type: string | null,
  code: number | null,
  hasPickupPoint: boolean,
): Status | null {
  if (type === null) {
    return null;
  }
  const override = code === null ? undefined : CODE_OVERRIDES[code];
  if (override !== undefined) {
    return override;
  }
  if (type === "STATUS_OK") {
    const known = code === null ? undefined : OK_CODES[code];
    return known ?? (hasPickupPoint ? "at_pickup_point" : "delivered");
  }
  return lookUpStatus(TYPES, type);
}

function readStatus(
  block: unknown,
  reports: Reports,
): { type: string | null; code: number | null } {
  const status = asObject(block);
  const type = text(status["statusType"]);
  const code = num(status["statusCode"]);
  if (type !== null && !KNOWN_TYPES.has(type)) {
    reports.type(type);
  }
  if (code !== null && !KNOWN_CODES.has(code)) {
    reports.code(String(code));
  }
  return { type, code };
}

export function history(
  events: unknown,
  hasPickupPoint: boolean,
  reports: Reports,
): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of objects(events)) {
    const at = isoTime(event["timestamp"], ZONE);
    const { type, code } = readStatus(event["status"], reports);
    const rawStatus =
      text(asObject(event["status"])["statusText"]) ?? (code === null ? null : String(code));
    if (at !== null && rawStatus !== null) {
      result.push({ at, rawStatus, status: mapStatus(type, code, hasPickupPoint), location: null });
    }
  }
  return newestFirst(result);
}

export interface Extras {
  readonly events: unknown;
  readonly pickupPointName: string | null;
}

export function toSnapshot(raw: Json, extras: Extras, reports: Reports): ParcelSnapshot | null {
  const barcode = text(raw["trackingId"]);
  if (barcode === null) {
    return null;
  }
  const last = asObject(raw["lastEvent"]);
  const hasPickupPoint = text(asObject(raw["delivery"])["pickupPointId"]) !== null;
  const { type, code } = readStatus(last["status"], reports);
  const status = mapStatus(type, code, hasPickupPoint);
  const bound = text(raw["bound"])?.toUpperCase();
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    direction: bound === "OUT" ? "outgoing" : "incoming",
    status,
    rawStatus:
      text(asObject(last["status"])["statusText"]) ?? (code === null ? null : String(code)),
    deliveredAt: status === "delivered" ? isoTime(last["timestamp"], ZONE) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: extras.pickupPointName,
    url: `https://dao.as/find-din-pakke/#q=${encodeURIComponent(barcode)}`,
    sender: text(asObject(raw["sender"])["name"]),
    receiver: text(asObject(raw["receiver"])["name"]),
    history: history(extras.events, hasPickupPoint, reports),
    raw,
  });
}
