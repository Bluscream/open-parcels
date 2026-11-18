import {
  isoTime,
  objects,
  ruleStatus,
  rulesStatus,
  snapshot,
  type Json,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { text } from "./shared.js";

export const CARRIER_ID = "posta_slovenije";
type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/**
 * A scan code from the shared table. `V` (not delivered) and the delivery scans depend on the
 * scans around them and are refined in `rowStatuses`.
 */
const codeStatus = (code: string): ParcelStatus | null => ruleStatus(CARRIER_ID, code);
const isDelivery = (code: string): boolean => codeStatus(code) === "delivered";
const isPickup = (code: string): boolean => codeStatus(code) === "at_pickup_point";

/** Whether a `V` scan's English action sends the parcel back (the table reads the wording). */
const sendsBack = (row: Json): boolean =>
  rulesStatus(CARRIER_ID, { text: text(row["nondeliveryActionEN"]) ?? "", fields: { scan: "V" } })
    ?.status === "returning";

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
      at: isoTime(row["statusDateTime"], { naive: { zone: "UTC" }, keepOffset: true }),
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
      returning = sendsBack(row);
      return returning ? "returning" : codeStatus(code);
    }
    const status = codeStatus(code);
    return returning && status === "delivered" ? "returning" : status;
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
  const lastDelivery = reversed.find((entry) => isDelivery(entry.code));
  const lastOther = reversed.find((entry) => !isDelivery(entry.code));
  let point: string | null = null;
  if (status === "at_pickup_point") {
    point = pickupPoint(reversed.find((entry) => isPickup(entry.code))?.row);
  } else if (delivered && lastOther !== undefined && isPickup(lastOther.code)) {
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
