import { loadRules, trackingUrl } from "open-parcels-rules";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "gofo";
/** Transport A answers in this zone's wall-clock time but always stamps a fixed -07:00. */
export const WALL_CLOCK_ZONE = "America/Los_Angeles";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;
export type Json = Readonly<Record<string, unknown>>;

/** Event process codes, shared by every country. Candidates for the shared rules package. */
const PROCESS_CODES: Readonly<Record<string, ParcelStatus>> = {
  "100": "registered",
  "200": "in_transit",
  "201": "in_transit",
  "202": "in_transit",
  "203": "in_transit",
  "204": "problem",
  "206": "problem",
  "208": "out_for_delivery",
  "411": "in_transit",
  "412": "in_transit",
  LS004: "at_pickup_point",
  "205": "delivered",
};

/** The coarse item status, used only when the latest event has no mapped code. */
const ITEM_STATUS: Readonly<Record<string, ParcelStatus>> = {
  Processing: "registered",
  Transit: "in_transit",
  Delivered: "delivered",
};

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: WALL_CLOCK_ZONE,
  timeZoneName: "longOffset",
});

function offsetMinutes(at: number): number {
  const name = offsetFormat.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** Parses a timestamp; with `wallClock`, the stamped offset is dropped and the zone's applies. */
export function isoTime(value: unknown, wallClock: boolean): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!wallClock) {
    const normalised = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const parsed = Date.parse(normalised);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(value);
  if (match === null) {
    return null;
  }
  const asUtc = Date.parse(`${match[1] ?? ""}T${match[2] ?? ""}Z`);
  if (Number.isNaN(asUtc)) {
    return null;
  }
  const first = asUtc - offsetMinutes(asUtc) * 60_000;
  return new Date(asUtc - offsetMinutes(first) * 60_000).toISOString();
}

function events(raw: Json): Json[] {
  const list = raw["trackEventList"];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (PROCESS_CODES[code] ?? null);
}

function resolve(
  raw: Json,
  report: (code: string) => void,
): { status: ParcelStatus | null; rawStatus: string | null } {
  const last = isObject(raw["lastTrackEvent"]) ? raw["lastTrackEvent"] : (events(raw)[0] ?? {});
  const code = text(last["processCode"]);
  const mapped = mapCode(code);
  if (mapped !== null) {
    return { status: mapped, rawStatus: text(last["processContent"]) ?? code };
  }
  if (code !== null) {
    report(code);
  }
  const itemStatus = text(raw["status"]);
  const fallback = itemStatus === null ? null : (ITEM_STATUS[itemStatus] ?? null);
  if (itemStatus !== null && fallback === null) {
    report(`status:${itemStatus}`);
  }
  return { status: fallback, rawStatus: itemStatus ?? code };
}

function weightKg(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function publicUrl(barcode: string, country: string): string {
  return (
    trackingUrl(loadRules(), CARRIER_ID, barcode) ??
    `https://www.gofo.com/${country.toLowerCase()}/track?number=${encodeURIComponent(barcode)}`
  );
}

/** One result item as a snapshot. No delivery window: those fields have never been seen filled. */
export function toSnapshot(
  raw: Json,
  barcode: string,
  country: string,
  options: { readonly wallClock: boolean; readonly report: (code: string) => void },
): ParcelSnapshot {
  const { status, rawStatus } = resolve(raw, options.report);
  const delivered = status === "delivered";
  const history: SnapshotEvent[] = [];
  for (const event of events(raw)) {
    const at = isoTime(event["processDate"], options.wallClock);
    const code = text(event["processCode"]);
    const label = text(event["processContent"]) ?? code;
    if (at !== null && label !== null) {
      history.push({ at, rawStatus: label, status: mapCode(code), location: null });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const deliveryEvent =
    events(raw).find((e) => text(e["processCode"]) === "205") ??
    (isObject(raw["lastTrackEvent"]) ? raw["lastTrackEvent"] : {});
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered ? isoTime(deliveryEvent["processDate"], options.wallClock) : null,
    pickup: status === "at_pickup_point",
    url: publicUrl(barcode, country),
    weightKg: weightKg(raw["weight"]),
    history,
    raw,
  });
}
