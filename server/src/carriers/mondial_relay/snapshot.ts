import {
  asObject,
  localDay,
  rulesTrackingUrl,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  CARRIER_ID,
  CARRIER_TZ,
  HISTORY_LIMIT,
  isoAt,
  parseTime,
  PICKUP_POINT_MODE,
  STEP_AVAILABLE,
  STEP_DELIVERED,
  stepStatus as tableStep,
} from "./shared.js";

/** Mondial Relay's fields are strings; a number in one is not taken as text. */
const str = (value: unknown): string | null => text(value, { numbers: false });

export interface Reporter {
  step(key: string): void;
  deliveryMode(mode: string): void;
}

interface Step {
  readonly number: number;
  readonly key: string;
  readonly at: number | null;
  readonly date: unknown;
}

/** Every step that carries an event, highest first. Non-numeric keys are reported and skipped. */
function reachedSteps(expedition: Json, report: Reporter): Step[] {
  const steps = asObject(expedition["SuiviParEtapes"]);
  const reached: Step[] = [];
  for (const [key, value] of Object.entries(steps)) {
    const mark = asObject(asObject(value)["Evenement"]);
    if (Object.keys(mark).length === 0) {
      continue;
    }
    const number = Number(key);
    if (!Number.isInteger(number)) {
      report.step(key);
      continue;
    }
    reached.push({ number, key, at: parseTime(mark["Date"], CARRIER_TZ), date: mark["Date"] });
  }
  return reached.sort((a, b) => b.number - a.number);
}

/** Status of a step, with "ready to collect" downgraded when the parcel is not for a relay point. */
function stepStatus(number: number, pickup: boolean): ParcelStatus | null {
  const status = tableStep(number);
  return status === "at_pickup_point" && !pickup ? "in_transit" : status;
}

/**
 * The relay point's name, from the event dated exactly as the "collected" or "ready" step. The
 * drop-off event names the sender's point, so events are matched by date, never position.
 */
function pickupPoint(expedition: Json, reached: readonly Step[]): string | null {
  const events = Array.isArray(expedition["Evenements"]) ? expedition["Evenements"] : [];
  for (const wanted of [STEP_DELIVERED, STEP_AVAILABLE]) {
    const date = reached.find((step) => step.number === wanted)?.date;
    if (typeof date !== "string") {
      continue;
    }
    const match = events.map(asObject).find((event) => event["Date"] === date);
    const name = str(asObject(asObject(match?.["DetailPointRelais"])["Adresse"])["Libelle"]);
    if (name !== null) {
      return name;
    }
  }
  return null;
}

/**
 * The latest expected day as a whole local day. The value is UTC without an offset; year 1 is the
 * carrier's placeholder for "no estimate yet".
 */
function plannedWindow(expedition: Json): { from: string | null; to: string | null } {
  const estimate = parseTime(expedition["EstimatedDeliveryDate"], null);
  if (estimate === null || new Date(estimate).getUTCFullYear() <= 1) {
    return { from: null, to: null };
  }
  const day = localDay(new Date(estimate).toISOString(), CARRIER_TZ);
  return { from: day?.from ?? null, to: day?.to ?? null };
}

/** Events carry no code; each takes the status of the latest step reached by its moment. */
function history(expedition: Json, reached: readonly Step[], pickup: boolean): SnapshotEvent[] {
  const marks = reached
    .map((step) => ({ at: step.at, status: stepStatus(step.number, pickup) }))
    .filter((mark) => mark.at !== null && mark.status !== null)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const events = Array.isArray(expedition["Evenements"]) ? expedition["Evenements"] : [];
  const result: { ms: number; event: SnapshotEvent }[] = [];
  for (const entry of events.map(asObject)) {
    const ms = parseTime(entry["Date"], CARRIER_TZ);
    const rawStatus = str(entry["Libelle"]);
    if (ms === null || rawStatus === null) {
      continue;
    }
    const status = marks.filter((mark) => (mark.at ?? 0) <= ms).at(-1)?.status ?? null;
    result.push({
      ms,
      event: { at: new Date(ms).toISOString(), status, rawStatus, location: null },
    });
  }
  return result
    .sort((a, b) => b.ms - a.ms)
    .slice(0, HISTORY_LIMIT)
    .map((item) => item.event);
}

/** A link that opens the parcel for anyone; built from number and brand, never the postcode. */
function publicUrl(expedition: Json): string | null {
  const number =
    str(expedition["Numero"]) ??
    (typeof expedition["Numero"] === "number" ? String(expedition["Numero"]) : null);
  const brand = str(expedition["Enseigne"]);
  if (number === null || brand === null || brand.length < 2) {
    return null;
  }
  return rulesTrackingUrl(CARRIER_ID, number, undefined, { brand: brand.slice(0, 2) });
}

/** Turns one `Expedition` into a snapshot. The highest reached step that maps decides the status. */
export function trackingSnapshot(
  expedition: Json,
  barcode: string,
  report: Reporter,
): ParcelSnapshot {
  const reached = reachedSteps(expedition, report);
  for (const step of reached) {
    if (tableStep(step.number) === null) {
      report.step(step.key);
    }
  }
  const mode = str(expedition["DeliveryMode"]);
  const pickup = mode === PICKUP_POINT_MODE;
  if (!pickup) {
    report.deliveryMode(mode ?? "none");
  }
  const current = reached.find((step) => tableStep(step.number) !== null);
  const status = current === undefined ? null : stepStatus(current.number, pickup);
  const delivered = status === "delivered";
  const window = plannedWindow(expedition);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: reached[0]?.key ?? null,
    delivered,
    deliveredAt: delivered ? isoAt(current?.at ?? null) : null,
    plannedFrom: delivered ? null : window.from,
    plannedTo: delivered ? null : window.to,
    pickup,
    pickupPoint: pickup ? pickupPoint(expedition, reached) : null,
    url: publicUrl(expedition),
    // The merchant's code is the only sender the response carries.
    sender: str(expedition["Enseigne"]),
    history: history(expedition, reached, pickup),
    raw: expedition,
  });
}
