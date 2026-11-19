import { createHash } from "node:crypto";
import {
  carrierPattern,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
  expectStatus,
  rulesStatus,
  objects,
  readObject,
  text,
  zonedIso,
  type Json,
  type ParcelStatus,
  type PluginHttp,
  echoRef,
} from "../../plugin/api.js";

export const CARRIER_ID = "matkahuolto";
export const TRACKING_HOST = "wwwservice.matkahuolto.fi";
const TIME_ZONE = "Europe/Helsinki";

export const BARCODE_PATTERN = carrierPattern("matkahuolto");

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
  // Stable sentence fragments, first match wins; `label` replaces the carrier's own words.
  const found = rulesStatus(CARRIER_ID, { text: description.toLowerCase() });
  if (found === null) {
    report("description", createHash("sha256").update(description).digest("hex").slice(0, 16));
    return { status: null, label: null };
  }
  return { status: found.status, label: found.label ?? null };
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
    barcode,
    externalRef: echoRef(text(raw["parcelNumber"]), barcode),
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
