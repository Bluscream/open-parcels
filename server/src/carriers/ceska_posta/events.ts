import {
  asArray,
  asObject,
  isObject,
  newestFirst,
  parseLocal,
  text,
  type Json,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const ZONE = "Europe/Prague";

/**
 * A rank ladder, not a flat map: the status is the highest rank reached, because pickup-point
 * designation records can follow the final event.
 */
const STATUS_RANK: Readonly<Record<string, readonly [number, ParcelStatus]>> = {
  "-L": [10, "registered"],
  "-M": [10, "registered"],
  "21": [20, "in_transit"],
  "-F": [20, "in_transit"],
  "-I": [20, "in_transit"],
  "-B": [30, "in_transit"],
  "-K": [30, "in_transit"],
  "5K": [30, "in_transit"],
  "51": [40, "in_transit"],
  "53": [50, "out_for_delivery"],
  P2: [60, "at_pickup_point"],
  "82": [60, "at_pickup_point"],
  "91": [90, "delivered"],
};

/** Notification and designation records are not parcel states. */
const NOT_STATES = new Set(["42", "43", "BG1", "BG4", "BG5"]);
const NOT_FOUND = new Set(["-3", "-4"]);

export interface CpEvent {
  readonly id: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly text: string | null;
}

function rank(id: string): readonly [number, ParcelStatus] | undefined {
  return Object.hasOwn(STATUS_RANK, id) ? STATUS_RANK[id] : undefined;
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
    if (event.id === "" || NOT_STATES.has(event.id) || NOT_FOUND.has(event.id)) {
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
  return events.filter((e) => !NOT_STATES.has(e.id) && e.text !== null).at(-1)?.text ?? null;
}

export function buildHistory(events: readonly CpEvent[]): SnapshotEvent[] {
  const history: SnapshotEvent[] = [];
  for (const event of events) {
    if (event.id === "" || NOT_STATES.has(event.id) || event.date === null) {
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
