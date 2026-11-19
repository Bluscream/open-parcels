import {
  asObject,
  isoTime as kitIsoTime,
  newestFirst,
  num,
  objects,
  ruleFieldsStatus,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus as Status,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

export const CARRIER_ID = "dao";
const ZONE = "Europe/Copenhagen";

/** Epoch values (numbers or digit strings), offset times, and offset-less times in Copenhagen. */
const isoTime = (value: unknown, zone: string): string | null =>
  kitIsoTime(value, { naive: { zone }, epoch: "auto", epochStrings: true });

/** A value the shared table knows, mapped or known to carry no status. */
const isKnown = (fields: Readonly<Record<string, string>>): boolean =>
  ruleFieldsStatus(CARRIER_ID, fields) !== null;

export interface Reports {
  readonly type: (key: string) => void;
  readonly code: (key: string) => void;
}

/**
 * Maps a status: the type and code pair, and whether the parcel has a pickup point, through the
 * shared table (`STATUS_OK` means the parcel arrived: at a pickup point when it has one, else
 * delivered, unless a known code says which). Known values without a status give null.
 */
export function mapStatus(
  type: string | null,
  code: number | null,
  hasPickupPoint: boolean,
): Status | null {
  if (type === null) {
    return null;
  }
  const status = ruleFieldsStatus(CARRIER_ID, {
    statusType: type,
    ...(code === null ? {} : { statusCode: String(code) }),
    pickupPoint: hasPickupPoint ? "yes" : "no",
  });
  return status === "unknown" ? null : status;
}

function readStatus(
  block: unknown,
  reports: Reports,
): { type: string | null; code: number | null } {
  const status = asObject(block);
  const type = text(status["statusType"]);
  const code = num(status["statusCode"]);
  if (type !== null && !isKnown({ statusType: type })) {
    reports.type(type);
  }
  if (code !== null && !isKnown({ statusCode: String(code) })) {
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
    url: rulesTrackingUrl(CARRIER_ID, barcode),
    sender: text(asObject(raw["sender"])["name"]),
    receiver: text(asObject(raw["receiver"])["name"]),
    history: history(extras.events, hasPickupPoint, reports),
    raw,
  });
}
