import {
  asObject,
  isoTime,
  newestFirst,
  ruleStatus,
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
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? isoTime(value, { naive: { zone: "Europe/Bratislava" } })
    : null;
}
/** A code's status; the shared table maps codes that describe no movement to `unknown`. */
function codeStatus(code: string | null): ParcelStatus | null {
  const status = ruleStatus(CARRIER_ID, code);
  return status === "unknown" ? null : status;
}

/** Known codes that describe no movement (delivery instructions given on the web). */
const noMovement = (code: string): boolean => ruleStatus(CARRIER_ID, code) === "unknown";

function eventKey(event: Json): string | null {
  return text(event["statusCode"]) ?? text(event["status"]);
}

/** `statusCode` is preferred; the numeric `status` is the fallback. */
function mapEvent(event: Json): ParcelStatus | null {
  return codeStatus(text(event["statusCode"])) ?? codeStatus(text(event["status"]));
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
  if (eventStatus === null && key !== null && !noMovement(key)) {
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
