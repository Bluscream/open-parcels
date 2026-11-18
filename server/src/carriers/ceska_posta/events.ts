import {
  asArray,
  asObject,
  isObject,
  newestFirst,
  parseLocal,
  ruleStatus,
  text,
  type Json,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const ZONE = "Europe/Prague";
const CARRIER_ID = "ceska_posta";

/**
 * A ladder, not the newest event: the status is the furthest one reached, because pickup-point
 * designation records can follow the final event.
 */
const LADDER: readonly ParcelStatus[] = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
];
/** Answers that mean "no such parcel", not events. */
const NOT_FOUND = new Set(["-3", "-4"]);

/** The shared table maps notification and designation records to `unknown`: not states. */
const notAState = (id: string): boolean => ruleStatus(CARRIER_ID, id) === "unknown";

export interface CpEvent {
  readonly id: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly text: string | null;
}

/** The state's status and its place on the ladder; undefined for ids that do not map. */
function rank(id: string): readonly [number, ParcelStatus] | undefined {
  const status = ruleStatus(CARRIER_ID, id);
  const place = status === null ? -1 : LADDER.indexOf(status);
  return status === null || place < 0 ? undefined : [place, status];
}

/**
 * Events from the history service, with the time the Balíkovna page adds for the same code and
 * day. Without a history the page's own list is used.
 */
export function normalizeEvents(backbone: Json | null, enrichment: Json | null): CpEvent[] {
  const fromHistory = asArray(asObject(asObject(backbone)["states"])["state"]).filter(isObject);
  const fromPage = asArray(asObject(enrichment)["packageStates"]).filter(isObject);
  if (fromHistory.length === 0) {
    return fromPage.map((event) => ({
      id: text(event["stateId"]) ?? "",
      date: text(event["date"]),
      time: text(event["time"]),
      text: text(event["text"]),
    }));
  }
  const times = new Map<string, string>();
  for (const event of fromPage) {
    const time = text(event["time"]);
    const key = `${text(event["stateId"]) ?? ""}|${text(event["date"]) ?? ""}`;
    if (time !== null && !times.has(key)) {
      times.set(key, time);
    }
  }
  return fromHistory.map((event) => {
    const id = text(event["id"]) ?? "";
    const date = text(event["date"]);
    return { id, date, time: times.get(`${id}|${date ?? ""}`) ?? null, text: text(event["text"]) };
  });
}

export function deriveStatus(
  events: readonly CpEvent[],
  report: (code: string) => void,
): ParcelStatus | null {
  let best: readonly [number, ParcelStatus] | null = null;
  for (const event of events) {
    if (event.id === "" || notAState(event.id) || NOT_FOUND.has(event.id)) {
      continue;
    }
    const ranked = rank(event.id);
    if (ranked === undefined) {
      report(event.id);
    } else if (best === null || ranked[0] > best[0]) {
      best = ranked;
    }
  }
  return best?.[1] ?? null;
}

export function lastStatusText(events: readonly CpEvent[]): string | null {
  return events.filter((e) => !notAState(e.id) && e.text !== null).at(-1)?.text ?? null;
}

export function buildHistory(events: readonly CpEvent[]): SnapshotEvent[] {
  const history: SnapshotEvent[] = [];
  for (const event of events) {
    if (event.id === "" || notAState(event.id) || event.date === null) {
      continue;
    }
    const at = parseLocal(`${event.date.slice(0, 10)}T${event.time ?? "00:00"}`, ZONE);
    if (at !== null) {
      history.push({
        at,
        rawStatus: event.text ?? event.id,
        status: rank(event.id)?.[1] ?? null,
        location: null,
      });
    }
  }
  return newestFirst(history);
}
