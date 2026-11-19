import {
  asArray as asList,
  asObject,
  newestFirst,
  snapshot,
  type Json,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { CARRIER_ID, isoTime, lookUpCode, publicUrl, text } from "./shared.js";

type Report = (code: string) => void;

/** A customer is an object with a name, or sometimes the bare name. */
function nameOf(customer: unknown): string | null {
  return text(customer) ?? text(asObject(customer)["name"]);
}

function firstText(object: Json, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = text(object[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** The locker's open code and QR code open the locker; they never leave the plug-in. */
const LOCKER_CODES: ReadonlySet<string> = new Set([
  "openCode",
  "qrCode",
  "pickupCode",
  "unlockCode",
]);

/** The payload without locker codes, at any depth (the Italian inbox nests them under `pickUp`). */
function withoutCodes(raw: Json): Json {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !LOCKER_CODES.has(key))
        .map(([key, inner]) => [key, strip(inner)]),
    );
  };
  return strip(raw) as Json;
}

function inboxHistory(raw: Json, report: Report): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asList(raw["eventLog"])) {
    const event = asObject(entry);
    const at = isoTime(event["date"]);
    const name = text(event["name"]);
    if (at === null || name === null) {
      continue;
    }
    const status = lookUpCode("inbox", name, report);
    events.push({ at, rawStatus: name, status, location: null });
  }
  return newestFirst(events);
}

/**
 * One parcel of the Polish inbox. The detailed status is mapped first; an unknown one is
 * reported and the coarse group still gives a sensible status. The inbox gives no delivery
 * window: `expiryDate` is the locker's collection deadline, not an arrival time.
 */
export function plSnapshot(raw: Json, report: Report): ParcelSnapshot | null {
  const barcode = text(raw["shipmentNumber"]);
  if (barcode === null) {
    return null;
  }
  const rawStatus = text(raw["status"]);
  const group = text(raw["statusGroup"])?.toLowerCase() ?? null;
  const status = lookUpCode("inbox", rawStatus, report) ?? lookUpCode("inbox-group", group);
  const delivered = status === "delivered";
  const operations = asObject(raw["operations"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered ? isoTime(raw["pickUpDate"] ?? raw["returnedToSenderDate"]) : null,
    pickup: status === "at_pickup_point" || operations["collect"] === true,
    pickupPoint: firstText(asObject(raw["pickUpPoint"]), ["name", "locationDescription"]),
    url: publicUrl(barcode, "PL"),
    sender: nameOf(raw["sender"]),
    receiver: nameOf(raw["receiver"]),
    history: inboxHistory(raw, report),
    // The locker's open code and QR code must never leave the plug-in.
    raw: withoutCodes(raw),
  });
}

function itPickupPoint(raw: Json): string | null {
  const point = asObject(asObject(raw["pickUp"])["location"])["point"];
  return text(point) ?? firstText(asObject(point), ["name", "id", "description"]);
}

/** One parcel of the Italian inbox. It has no status of its own: its newest event's is used. */
export function itSnapshot(raw: Json, report: Report): ParcelSnapshot | null {
  const barcode = text(raw["primaryParcelNumber"]);
  if (barcode === null) {
    return null;
  }
  const history: SnapshotEvent[] = [];
  for (const entry of asList(raw["events"])) {
    const event = asObject(entry);
    const at = isoTime(event["eventTime"]);
    const code = text(event["status"]);
    const rawStatus = text(event["eventCode"]) ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    history.push({
      at,
      rawStatus,
      status: lookUpCode("group", code, report),
      location: null,
    });
  }
  const sorted = newestFirst(history);
  const latest = sorted[0];
  const status = latest?.status ?? null;
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered ? (latest?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: itPickupPoint(raw),
    url: publicUrl(barcode, "IT"),
    sender: text(asObject(raw["sender"])["representativeName"]),
    receiver: text(asObject(raw["receiver"])["representativeName"]),
    history: sorted,
    // The same as the Polish inbox: locker codes never leave the plug-in.
    raw: withoutCodes(raw),
  });
}
