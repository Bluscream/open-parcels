import {
  carrierPattern,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import {
  asObject,
  CARRIER_ID,
  carrierTime,
  isObject,
  localized,
  mapText,
  publicUrl,
  text,
  TRACKING_HOST,
  zurichTime,
  type Json,
} from "./shared.js";

const BARCODE_PATTERN = carrierPattern("planzer");
/** `overallStatus.color` 3 is the app's "danger" severity. */
const DANGER_COLOR = 3;

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Looks one shipment up. `Pak` selects the parcel system, the only public one. An unknown code is
 * a bare 404; any other non-200 means the request itself is wrong.
 */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/api/v1/shipments/${encodeURIComponent(barcode)}/Pak`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Planzer tracking answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Planzer tracking did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("Planzer tracking did not answer with an object.");
  }
  return payload;
}

/** A shipment is a list of positions; consumer parcels have one. */
function positions(raw: Json): Json[] {
  const list = raw["transportPositions"];
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function sequence(event: Json): number {
  const value = event["sequenceOrder"];
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
}

/** Every position's events, oldest first by `sequenceOrder`, the carrier's own ordering field. */
function positionEvents(list: readonly Json[]): Json[] {
  return list
    .flatMap((position) =>
      Array.isArray(position["positionEvents"]) ? (position["positionEvents"] as unknown[]) : [],
    )
    .filter(isObject)
    .sort((a, b) => sequence(a) - sequence(b));
}

const CLOCK_PATTERN = /^\d{2}:\d{2}(:\d{2})?$/;

function clock(value: unknown): string | null {
  const raw = text(value);
  return raw !== null && CLOCK_PATTERN.test(raw) ? raw.padEnd(8, ":00") : null;
}

/**
 * `deliveryDay.date` is a bare date. A time window, when given, narrows it to its outer bounds;
 * otherwise the whole day counts, in Zurich time.
 */
export function plannedWindow(raw: Json): { from: string | null; to: string | null } {
  const day = asObject(raw["deliveryDay"]);
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(text(day["date"]) ?? "")?.[1];
  if (date === undefined) {
    return { from: null, to: null };
  }
  const window = asObject(day["timeWindowSettings"]);
  const starts = [clock(window["start"]), clock(window["secondStart"])].filter((v) => v !== null);
  const ends = [clock(window["end"]), clock(window["secondEnd"])].filter((v) => v !== null);
  const start = starts.sort()[0] ?? "00:00:00";
  const end = ends.sort().at(-1) ?? "23:59:59";
  return { from: zurichTime(`${date}T${start}`), to: zurichTime(`${date}T${end}`) };
}

function totalWeightKg(list: readonly Json[]): number | null {
  const grams = list.map((p) => p["weightGs"]).filter((g) => typeof g === "number");
  return grams.length === 0 ? null : Math.round(grams.reduce((a, b) => a + b, 0)) / 1000;
}

/**
 * Overall status first; an unmapped one painted as danger is a problem; then a newest event
 * flagged unsuccessful; then the newest event's own text.
 */
function resolveStatus(
  raw: Json,
  events: readonly Json[],
  report: (key: string) => void,
): SnapshotEvent["status"] {
  const overall = asObject(raw["overallStatus"]);
  const overallText = localized(overall["text"], "german");
  const mapped = mapText(overallText, report);
  if (mapped !== null) {
    return mapped;
  }
  if (overallText !== null && overall["color"] === DANGER_COLOR) {
    return "problem";
  }
  const newest = events.at(-1);
  if (newest === undefined) {
    return null;
  }
  if (newest["success"] === false) {
    return "problem";
  }
  return mapText(localized(newest["text"], "german"), () => undefined);
}

function history(events: readonly Json[], report: (key: string) => void): SnapshotEvent[] {
  const entries: SnapshotEvent[] = [];
  for (const event of events) {
    const at = carrierTime(event["createdAt"]);
    const rawStatus = localized(event["text"], "english");
    if (at === null || rawStatus === null) {
      continue;
    }
    const status = mapText(localized(event["text"], "german"), report);
    entries.push({ at, status, rawStatus, location: null });
  }
  return entries.reverse();
}

/** Turns one shipment into a snapshot; `report` receives unmapped German status texts. */
export function trackingSnapshot(
  raw: Json,
  barcode: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const list = positions(raw);
  const events = positionEvents(list);
  // Each unmapped text is reported once per run, wherever it appears.
  const seen = new Set<string>();
  const once = (key: string): void => {
    if (!seen.has(key)) {
      seen.add(key);
      report(key);
    }
  };
  const status = resolveStatus(raw, events, once);
  const delivered = status === "delivered";
  const window = delivered ? { from: null, to: null } : plannedWindow(raw);
  const newest = events.at(-1);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["shipmentNumber"]), barcode),
    status,
    rawStatus:
      localized(asObject(raw["overallStatus"])["text"], "english") ??
      localized(newest?.["text"], "english"),
    delivered,
    deliveredAt: delivered && newest !== undefined ? carrierTime(newest["createdAt"]) : null,
    plannedFrom: window.from,
    plannedTo: window.to,
    url: publicUrl(barcode),
    weightKg: totalWeightKg(list),
    history: history(events, once),
    raw,
  });
}
