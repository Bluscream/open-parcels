import {
  asObject,
  isoTime,
  newestFirst,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "slovak_parcel_service";

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Event times are Slovak local time without an offset; ones with an offset are trusted. */
export function slovakTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (LOCAL_TIME.test(value.trim())) {
    return isoTime(value, { naive: { zone: "Europe/Bratislava" } });
  }
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? isoTime(value, { naive: "runtime" }) : null;
}
/** `statusCode` is preferred; the numeric `status` is the fallback. */
const EVENT_MAP: Readonly<Record<string, ParcelStatus>> = {
  DDEF: "registered",
  INIT: "registered",
  TOUR: "out_for_delivery",
  DELY: "delivered",
  PICK: "in_transit",
  RETC: "in_transit",
  "8": "registered",
  "10": "registered",
  "30": "out_for_delivery",
  "40": "delivered",
  "44": "in_transit",
  "50": "in_transit",
};

/** Known codes that describe no movement (delivery instructions given on the web). */
const NO_MOVEMENT = new Set(["DDSP", "38"]);

function eventKey(event: Json): string | null {
  return text(event["statusCode"]) ?? text(event["status"]);
}

function mapEvent(event: Json): ParcelStatus | null {
  const named = text(event["statusCode"]);
  const numeric = text(event["status"]);
  return (
    (named === null ? undefined : EVENT_MAP[named]) ??
    (numeric === null ? undefined : EVENT_MAP[numeric]) ??
    null
  );
}

/** Turns one track-and-trace result into a snapshot; `report` receives unmapped codes. */
export function shipmentSnapshot(raw: Json, report: (code: string) => void): ParcelSnapshot {
  const barcode = text(raw["shipmentNr"]) ?? "";
  const states = Array.isArray(raw["states"]) ? raw["states"].map(asObject) : [];
  const lastScan = text(raw["lastStatusScan"]);
  // `lastStatusScan` names the current event; the list is newest first otherwise.
  const current = states.find((state) => text(state["statusCode"]) === lastScan) ?? states[0];
  const eventStatus = current === undefined ? null : mapEvent(current);
  const key = current === undefined ? null : eventKey(current);
  if (eventStatus === null && key !== null && !NO_MOVEMENT.has(key)) {
    report(key);
  }
  const status = text(raw["shipmentStatus"]) === "delivered" ? "delivered" : eventStatus;
  const entries: SnapshotEvent[] = [];
  for (const state of states) {
    const at = slovakTime(state["time"]);
    const rawStatus = text(state["statusDescr"]) ?? eventKey(state);
    if (at !== null && rawStatus !== null) {
      entries.push({ at, status: mapEvent(state), rawStatus, location: null });
    }
  }
  const history = newestFirst(entries);
  const deliveredAt =
    status === "delivered" ? (history.find((e) => e.status === "delivered")?.at ?? null) : null;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus:
      (current === undefined ? null : (text(current["statusDescr"]) ?? eventKey(current))) ??
      text(raw["shipmentStatus"]),
    delivered: status === "delivered",
    deliveredAt,
    url: `https://mysps.sk/sk/tracking/${encodeURIComponent(barcode)}`,
    history,
    raw: {
      shipmentStatus: raw["shipmentStatus"],
      lastStatusScan: raw["lastStatusScan"],
      states: raw["states"],
    },
  });
}
