import {
  loadRules,
  mapStatus,
  asArray,
  asObject,
  text,
  type Json,
  type ParcelStatus,
  type StatusTable,
} from "../../plugin/api.js";
import type { Moment } from "./time.js";

/** The shared table knows Amazon's codes by this id; it is also the parcel's carrier. */
export const AMAZON_ID = "amazon";

/**
 * Tracker codes the shared Amazon table does not list yet, keyed on the code reduced to A-Z0-9.
 * Candidates for the rules repository.
 */
export const TRACKER_STATUS: StatusTable = {
  CREATIONCONFIRMED: "registered",
  PICKUPDONE: "in_transit",
  RECEIVED: "in_transit",
  DEPARTED: "in_transit",
  DELIVEREDTODOORSTEP: "delivered",
};

/**
 * Codes never seen on the wire, matched by wording. Return and failure words are tried before
 * DELIVERED, which many of them contain. A match here is a guess and is reported.
 */
const INFERRED: readonly (readonly [readonly string[], ParcelStatus])[] = [
  [["RETURN"], "returning"],
  [
    [
      "NOTDELIVERED",
      "UNDELIVER",
      "ATTEMPT",
      "FAIL",
      "EXCEPTION",
      "DAMAGE",
      "LOST",
      "CANCEL",
      "REFUS",
    ],
    "problem",
  ],
  [
    ["READYFORPICKUP", "READYFORCOLLECTION", "AWAITINGPICKUP", "AWAITINGCOLLECTION"],
    "at_pickup_point",
  ],
  [["CUSTOMS"], "in_transit"],
  [["OUTFORDELIVERY"], "out_for_delivery"],
  [["DELIVERED"], "delivered"],
];

/** Summary words about the schedule, not the parcel's whereabouts: they decide nothing. */
const SCHEDULE_FLAGS = ["DELAYED"];

/** A Departed scan this soon after OutForDelivery at the same place is the van leaving. */
const VAN_LEAVING_MS = 60 * 60 * 1000;

export const key = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "OutForDelivery" → "OUT_FOR_DELIVERY", the spelling the shared table uses. */
const snake = (code: string): string =>
  code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

/** Maps one code; `report` hears codes that only matched by wording or did not match at all. */
export function classify(code: string | null, report: (code: string) => void): ParcelStatus | null {
  if (code === null || key(code) === "") {
    return null;
  }
  const shared = mapStatus(loadRules(), AMAZON_ID, { code: snake(code) });
  const exact = shared?.status ?? TRACKER_STATUS[key(code)];
  if (exact !== undefined) {
    return exact;
  }
  if (SCHEDULE_FLAGS.some((flag) => key(code).includes(flag))) {
    return null;
  }
  report(code);
  const inferred = INFERRED.find(([words]) => words.some((word) => key(code).includes(word)));
  return inferred?.[1] ?? null;
}

export interface TrackerEvent {
  readonly moment: Moment;
  readonly code: string | null;
  readonly location: string;
  readonly raw: Json;
}

function locationKey(event: Json): string {
  const location = asObject(event["location"]);
  return Object.keys(location)
    .sort()
    .map((name) => `${name}=${JSON.stringify(location[name])}`)
    .join("|");
}

/** Events oldest first, duplicates (same time, place and code) removed, ties in wire order. */
export function orderedEvents(
  events: unknown,
  parse: (value: unknown) => Moment | null,
): TrackerEvent[] {
  const seen = new Set<string>();
  const result: TrackerEvent[] = [];
  for (const entry of asArray(events)) {
    const raw = asObject(entry);
    const moment = parse(raw["eventTime"]);
    if (moment === null) {
      continue;
    }
    const code = text(raw["eventCode"]);
    const location = locationKey(raw);
    const identity = `${moment.sortKey}/${location}/${code ?? ""}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      result.push({ moment, code, location, raw });
    }
  }
  return result.sort((a, b) => a.moment.sortKey - b.moment.sortKey);
}

function vanLeaving(events: readonly TrackerEvent[], index: number): boolean {
  const departed = events[index];
  const earlier = events
    .slice(0, index)
    .reverse()
    .find((event) => key(event.code ?? "") === "OUTFORDELIVERY");
  if (departed === undefined || earlier === undefined) {
    return false;
  }
  const gap = departed.moment.sortKey - earlier.moment.sortKey;
  return earlier.location === departed.location && gap >= 0 && gap <= VAN_LEAVING_MS;
}

export function metaValue(metadata: Json, name: string): unknown {
  const item = metadata[name];
  if (typeof item !== "object" || item === null) {
    return item;
  }
  const value = asObject(item);
  return value["stringValue"] ?? value["date"] ?? value["value"] ?? null;
}

/**
 * The summary's word wins unless it only echoes the newest event, in which case the events
 * (with the van-leaving refinement) say more; then the container tags; then nothing.
 */
export function resolveStatus(
  summary: Json,
  events: readonly TrackerEvent[],
  report: (code: string) => void,
): { status: ParcelStatus | null; rawStatus: string | null } {
  const summaryCode =
    text(metaValue(asObject(summary["metadata"]), "trackingStatus")) ?? text(summary["status"]);
  const newestCode = events.at(-1)?.code ?? null;
  const fromSummary = classify(summaryCode, report);
  if (fromSummary !== null && key(summaryCode ?? "") !== key(newestCode ?? "")) {
    return { status: fromSummary, rawStatus: summaryCode };
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const code = events[index]?.code ?? null;
    const status = classify(code, report);
    if (status !== null) {
      const refined =
        key(code ?? "") === "DEPARTED" && vanLeaving(events, index) ? "out_for_delivery" : status;
      return { status: refined, rawStatus: code };
    }
  }
  for (const tag of asArray(summary["containerStatusTags"])) {
    const status = classify(text(tag), report);
    if (status !== null) {
      return { status, rawStatus: text(tag) };
    }
  }
  return { status: null, rawStatus: summaryCode ?? newestCode };
}
