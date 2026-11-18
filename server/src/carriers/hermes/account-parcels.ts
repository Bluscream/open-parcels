import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import {
  asObject,
  CARRIER_ID,
  isoTime,
  mapCode,
  newestFirst,
  publicUrl,
  text,
  type Json,
} from "./shared.js";

/**
 * One address block serves every destination; `addressType` tells them apart. Only a PaketShop
 * names a pickup point, with the shop's name in `lastName`. Reading other types would publish the
 * receiver's own name as a shop.
 */
function pickupPoint(address: Json): string | null {
  if (address["addressType"] !== "PARCELSHOP") {
    return null;
  }
  const locality = [text(address["zipCode"]), text(address["city"])]
    .filter((part) => part !== null)
    .join(" ");
  const parts = [
    text(address["lastName"]),
    text(address["street"]),
    locality === "" ? null : locality,
  ];
  const joined = parts.filter((part) => part !== null).join(", ");
  return joined === "" ? null : joined;
}

function historyEvents(raw: Json): SnapshotEvent[] {
  const entries = Array.isArray(raw["parcelHistory"]) ? (raw["parcelHistory"] as unknown[]) : [];
  const events: SnapshotEvent[] = [];
  for (const entry of entries) {
    const event = asObject(entry);
    const at = isoTime(event["timestamp"]);
    const code = text(event["status"]);
    const rawStatus =
      text(event["statusHistoryText"]) ?? text(event["statusHistoryShortText"]) ?? code;
    if (at === null || rawStatus === null) {
      continue;
    }
    events.push({ at, rawStatus, status: mapCode(code)?.status ?? null, location: null });
  }
  // The account lists history oldest first; the snapshot keeps it newest first.
  return newestFirst(events);
}

/**
 * One `GET shipments` element as a snapshot, or null without a barcode. The current status is
 * `status.parcelStatus`, never a history entry; a thin element without a status block is
 * reported as unknown (null) and left to the history fallback.
 */
export function accountSnapshot(raw: Json, report: (code: string) => void): ParcelSnapshot | null {
  const barcode = text(raw["barcode"]);
  if (barcode === null) {
    return null;
  }
  const block = asObject(raw["status"]);
  const code = text(block["parcelStatus"]);
  const mapped = mapCode(code);
  if (code !== null && mapped === null) {
    report(code);
  }
  const status = mapped?.status ?? null;
  // Hermes' own flag, except that a parcel waiting on a shop counter is not with the recipient.
  const delivered =
    asObject(raw["metaInformation"])["delivered"] === true && status !== "at_pickup_point";
  const address = asObject(raw["address"]);
  const statusText = asObject(block["text"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(statusText["shortText"]) ?? code,
    delivered,
    deliveredAt: delivered ? (isoTime(block["deliveryTime"]) ?? isoTime(block["timestamp"])) : null,
    pickup: mapped?.pickup === true || status === "at_pickup_point",
    pickupPoint: pickupPoint(address),
    url: publicUrl(barcode),
    sender: text(asObject(raw["atg"])["companyName"]),
    receiver: text(address["firstName"]),
    history: historyEvents(raw),
    raw,
  });
}
