import { createHash } from "node:crypto";
import {
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
  expectStatus,
  objects,
  readObject,
  text,
  zonedIso,
  type Json,
  type ParcelStatus,
  type PluginHttp,
} from "../../plugin/api.js";

export const CARRIER_ID = "matkahuolto";
export const TRACKING_HOST = "wwwservice.matkahuolto.fi";
const TIME_ZONE = "Europe/Helsinki";

/**
 * The carrier sends a free English sentence per event, with no status code. Sentences are matched
 * on stable fragments, first match wins. Some sentences name a pickup shop and its address, so a
 * generic label is shown instead of the carrier's own words.
 */
const PATTERNS: readonly (readonly [string, ParcelStatus, string])[] = [
  ["returned it to the sender", "returning", "Returned to sender"],
  ["the consignment has been delivered", "delivered", "Delivered"],
  ["available for pickup", "at_pickup_point", "Available for pickup"],
  ["sent the recipient a message about the arrival", "at_pickup_point", "Arrival notice sent"],
  ["forget to pick up your parcel", "at_pickup_point", "Available for pickup"],
  ["pick up point has changed", "in_transit", "Redirected to a new pickup point"],
  [
    "collected the consignment from the parcel pick-up point",
    "in_transit",
    "Collected from a drop-off point",
  ],
  ["deliver the consignment to the pickup point", "in_transit", "On its way to a pickup point"],
  ["ready to continue its journey", "in_transit", "Ready to continue its journey"],
  ["is on its way", "in_transit", "On its way"],
  ["has been sorted", "in_transit", "Sorted"],
  ["waiting for the consignment from the sender", "registered", "Awaiting handover from sender"],
  ["ready for delivery at the parcel pick-up point", "registered", "Waiting at a drop-off point"],
  ["consignment is being processed", "registered", "Being processed"],
];

export const BARCODE_PATTERN = /^[A-Z0-9]{6,40}$/i;

export type Report = (kind: string, key: string) => void;

export function publicUrl(barcode: string): string {
  return `https://www.matkahuolto.fi/seuranta?parcelNumber=${encodeURIComponent(barcode)}`;
}

/** Returns the parcel, or null when the carrier answers `{"notFound": true}` (HTTP 200). */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${TRACKING_HOST}/search/trackingInfo`);
  url.searchParams.set("language", "en");
  url.searchParams.set("parcelNumber", barcode);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  expectStatus(response, "Matkahuolto tracking", 200);
  const payload = readObject(response, "Matkahuolto tracking");
  if (payload["notFound"] === true) {
    return null;
  }
  if (!("trackingEvents" in payload) && !("parcelNumber" in payload)) {
    throw new UnexpectedResponseError("Matkahuolto tracking answered in an unknown shape.");
  }
  return payload;
}

interface Matched {
  readonly status: ParcelStatus | null;
  readonly label: string | null;
}

/** Unknown sentences are reported as a short hash: they can carry a shop name and address. */
function match(description: string | null, report: Report): Matched {
  if (description === null) {
    return { status: null, label: null };
  }
  const lowered = description.toLowerCase();
  const found = PATTERNS.find(([needle]) => lowered.includes(needle));
  if (found === undefined) {
    report("description", createHash("sha256").update(description).digest("hex").slice(0, 16));
    return { status: null, label: null };
  }
  return { status: found[1], label: found[2] };
}

/** `date` is DD.MM.YYYY and `time` HH:MM, Finnish wall-clock time. */
function eventTime(event: Json): string | null {
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text(event["date"]) ?? "");
  const clock = /^(\d{2}):(\d{2})$/.exec(text(event["time"]) ?? "");
  if (date === null || clock === null) {
    return null;
  }
  return zonedIso(
    {
      year: Number(date[3]),
      month: Number(date[2]),
      day: Number(date[1]),
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: 0,
    },
    TIME_ZONE,
  );
}

/** The shop name only; the street address after the first comma is more than the field needs. */
function shopName(place: string | null): string | null {
  return text(place?.split(",")[0]?.trim());
}

export function trackingSnapshot(raw: Json, barcode: string, report: Report): ParcelSnapshot {
  const events = objects(raw["trackingEvents"]);
  const history: SnapshotEvent[] = [];
  let latest: (Matched & { event: Json }) | null = null;
  // The list is newest first.
  for (const event of events) {
    const matched = match(text(event["description"]), report);
    latest ??= { ...matched, event };
    const at = eventTime(event);
    if (at !== null) {
      history.push({
        at,
        status: matched.status,
        rawStatus: matched.label ?? "Unrecognised update",
        location: null,
      });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const status = latest?.status ?? null;
  const delivered = status === "delivered";
  const pickup = status === "at_pickup_point";
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(raw["parcelNumber"]) ?? barcode,
    status,
    rawStatus: latest?.label ?? null,
    delivered,
    deliveredAt: delivered && latest !== null ? eventTime(latest.event) : null,
    pickup,
    pickupPoint: pickup && latest !== null ? shopName(text(latest.event["place"])) : null,
    url: publicUrl(barcode),
    history,
    raw,
  });
}
