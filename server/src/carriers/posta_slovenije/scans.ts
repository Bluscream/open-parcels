import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import { objects, text, zonedIso, type Json } from "../../plugin/parse.js";

export const CARRIER_ID = "posta_slovenije";
type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/*
 * Pošta Slovenije scan codes. The shared rules have no table for this carrier yet; this one
 * belongs there. `V` (not delivered) and the delivery codes depend on the scans around them and
 * are handled in `rowStatuses`.
 */
const CODES: Readonly<Record<string, ParcelStatus>> = {
  NAJ: "registered",
  S: "in_transit",
  EMC: "in_transit",
  N: "out_for_delivery",
  VLPAKP: "out_for_delivery",
  IZR: "at_pickup_point",
  PVI: "at_pickup_point",
  VDO: "problem",
  POTPKTM: "problem",
  VRP: "returning",
};
const PICKUP_CODES = new Set(["IZR", "PVI"]);
const DELIVERY_CODES = new Set(["VL", "VR"]);
const RETURN_WORDING = /returned to (the )?sender/i;

interface Row {
  readonly at: string;
  readonly row: Json;
  readonly code: string;
}

/** Scans with a readable time, oldest first. Times without an offset are UTC. */
function timedRows(statuses: unknown): Row[] {
  return objects(statuses)
    .map((row) => ({
      row,
      at: zonedIso(row["statusDateTime"], "UTC"),
      code: text(row["code"]) ?? "",
    }))
    .filter((entry): entry is Row => entry.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Each scan's status, oldest first. A `V` whose action sends the parcel back is a return, any
 * other `V` a problem; a delivery scan after a return is the return arriving, not a delivery.
 */
function rowStatuses(rows: readonly Row[]): (ParcelStatus | null)[] {
  let returning = false;
  return rows.map(({ row, code }) => {
    if (code === "V") {
      returning = RETURN_WORDING.test(text(row["nondeliveryActionEN"]) ?? "");
      return returning ? "returning" : "problem";
    }
    if (DELIVERY_CODES.has(code)) {
      return returning ? "returning" : "delivered";
    }
    return CODES[code] ?? null;
  });
}

const rawStatus = (row: Json): string | null =>
  text(row["codeDescriptionEN"]) ?? text(row["codeDescriptionSI"]) ?? text(row["code"]);

function pickupPoint(row: Json | undefined): string | null {
  if (row === undefined) {
    return null;
  }
  const parts = [text(row["postalName"]), text(row["pickupAddress"])].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? null : parts.join(", ");
}

export interface ScanInput {
  readonly barcode: string;
  readonly statuses: unknown;
  readonly direction: ParcelSnapshot["direction"];
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly raw: unknown;
}

/** One parcel from its scan rows; the parcel-level summary lags and is never read. */
export function scanSnapshot(input: ScanInput, report: (code: string) => void): ParcelSnapshot {
  const rows = timedRows(input.statuses);
  const statuses = rowStatuses(rows);
  const history: SnapshotEvent[] = rows
    .map(({ row, at }, index) => ({
      at,
      status: statuses[index] ?? null,
      rawStatus: rawStatus(row) ?? "",
      location: text(row["postalName"]),
    }))
    .filter((event) => event.rawStatus !== "")
    .reverse();
  const newest = rows.at(-1);
  if (newest !== undefined && statuses.at(-1) === null) {
    report(newest.code === "" ? "(none)" : newest.code);
  }
  const status = [...statuses].reverse().find((value) => value !== null) ?? null;
  const delivered = status === "delivered";
  const reversed = [...rows].reverse();
  const lastDelivery = reversed.find((entry) => DELIVERY_CODES.has(entry.code));
  const lastOther = reversed.find((entry) => !DELIVERY_CODES.has(entry.code));
  let point: string | null = null;
  if (status === "at_pickup_point") {
    point = pickupPoint(reversed.find((entry) => PICKUP_CODES.has(entry.code))?.row);
  } else if (delivered && lastOther !== undefined && PICKUP_CODES.has(lastOther.code)) {
    point = pickupPoint(lastOther.row);
  }
  return snapshot({
    carrier: CARRIER_ID,
    barcode: input.barcode,
    direction: input.direction,
    status,
    rawStatus: newest === undefined ? null : rawStatus(newest.row),
    delivered,
    deliveredAt: delivered ? (lastDelivery?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: point,
    url: `https://moja.posta.si/tracking?trackingNumber=${encodeURIComponent(input.barcode)}`,
    sender: input.sender,
    receiver: input.receiver,
    history,
    raw: input.raw,
  });
}
