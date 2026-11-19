import {
  ruleStatus,
  asObject,
  isoTime,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";

/** Offset-less timestamps are the carrier's local time; numbers are epoch ms. */
const LOCAL_TIME = { naive: { zone: "Europe/Zurich" }, epoch: "ms" } as const;

export const CARRIER_ID = "swiss_post";

const DIRECTIONS = ["*", "INLAND", "IMPORT", "EXPORT"] as const;

/**
 * An event's wording from the tracker's own table. `eventCode` is `KIND.*.PRODUCT.CODE`; the
 * product, then `ALL_PROD`, then the wildcard are tried, each closed by a direction, with the
 * sub-event detail ("Reason: …") ahead of the plain code.
 */
export function eventWording(texts: ReadonlyMap<string, string>, event: Json): string | null {
  const parts = (text(event["eventCode"]) ?? "").split(".");
  const [kind, , product, number] = parts;
  if (parts.length < 4 || kind === undefined || product === undefined || number === undefined) {
    return null;
  }
  const detail = [text(event["subEventDetailCode"]), text(event["subEventId"])].filter(
    (part): part is string => part !== null,
  );
  const suffixes = detail.length > 0 ? [`.${detail.join(".")}`, ""] : [""];
  const keys = [product, "ALL_PROD", "*"].flatMap((candidate) =>
    suffixes.flatMap((suffix) =>
      DIRECTIONS.map((direction) => `${kind}.*.${candidate}.${number}.${direction}${suffix}`),
    ),
  );
  for (const key of keys) {
    const wording = texts.get(key);
    if (wording !== undefined && wording !== "") {
      return wording;
    }
  }
  return null;
}

function history(events: readonly Json[], texts: ReadonlyMap<string, string>): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["timestamp"], LOCAL_TIME);
    const rawStatus = eventWording(texts, event) ?? text(event["eventCode"]);
    if (at !== null && rawStatus !== null) {
      // The place fields of an event have not been confirmed yet, so none is read.
      result.push({ at, status: null, rawStatus, location: null });
    }
  }
  return result.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** `deliveryRange` is a real window; `calculatedDeliveryDate` is a day-level point estimate. */
function window(raw: Json): { from: string | null; to: string | null } {
  const range = asObject(raw["deliveryRange"]);
  const from =
    isoTime(range["start"], LOCAL_TIME) ?? isoTime(raw["calculatedDeliveryDate"], LOCAL_TIME);
  const to = isoTime(range["end"], LOCAL_TIME);
  return { from, to: to === from ? null : to };
}

function receiver(raw: Json): string | null {
  const addressee = asObject(raw["addressee"]);
  const place = [text(addressee["zip"]), text(addressee["city"])].filter((p) => p !== null);
  return place.length === 0 ? null : place.join(" ");
}

function weightKg(raw: Json): number | null {
  const grams = asObject(raw["physicalProperties"])["weight"];
  return typeof grams === "number" && Number.isFinite(grams) ? Math.round(grams) / 1000 : null;
}

/** Turns one shipment (plus its events) into a snapshot; `report` receives unmapped statuses. */
export function shipmentSnapshot(
  raw: Json,
  events: readonly Json[],
  texts: ReadonlyMap<string, string>,
  report: (code: string) => void,
): ParcelSnapshot {
  const code = text(raw["globalStatus"]);
  const status = ruleStatus(CARRIER_ID, code);
  if (code !== null && status === null) {
    report(code);
  }
  // The payload's own flag survives an unmapped status.
  const delivered = raw["delivered"] === true || status === "delivered";
  const { from, to } = window(raw);
  const officeZip = text(raw["deliveryPostOfficeZip"]);
  const pickup = !delivered && (officeZip !== null || text(raw["avis"]) !== null);
  const barcode = text(raw["shipmentNumber"]) ?? "";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(raw["status"]) ?? code,
    delivered,
    deliveredAt: delivered ? isoTime(raw["deliveryDate"], LOCAL_TIME) : null,
    plannedFrom: delivered ? null : from,
    plannedTo: delivered ? null : to,
    pickup,
    pickupPoint: pickup ? officeZip : null,
    url: `https://service.post.ch/ekp-web/ui/entry/search/${encodeURIComponent(barcode)}`,
    sender: text(raw["sender"]),
    receiver: receiver(raw),
    weightKg: weightKg(raw),
    history: history(events, texts),
    raw,
  });
}
