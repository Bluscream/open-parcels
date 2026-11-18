import {
  asObject,
  isObject,
  isoTime as kitIsoTime,
  snapshot,
  text as anyText,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "la_poste";

/** Colissimo event groups and current-state codes. Candidates for the shared rules package. */
const COLISSIMO: Readonly<Record<string, ParcelStatus>> = {
  EXPANN: "registered",
  EDRDEP: "in_transit",
  EDRINT: "in_transit",
  ACHNAT: "in_transit",
  ACHORI: "in_transit",
  ACHERI: "in_transit",
  ACHDOU: "in_transit",
  DISINTAS: "in_transit",
  DISARR: "in_transit",
  DISTOU: "in_transit",
  DISIRST: "in_transit",
  AARIDOU: "in_transit",
  AARENDDOU: "in_transit",
  AARIREF: "in_transit",
  ACHIECA: "problem",
  AARAREF: "problem",
  AARABECH: "problem",
  DISIECHEC: "problem",
  DESLIVD: "delivered",
  DESOBS: "delivered",
  DESLIVHD: "delivered",
  DESMDREXP: "returning",
  DISINS: "at_pickup_point",
};

/** Chronopost event codes. Candidates for the shared rules package. */
const CHRONOPOST: Readonly<Record<string, ParcelStatus>> = {
  PC1: "in_transit",
  ET1: "in_transit",
  EP1: "in_transit",
  MD2: "in_transit",
  DR1: "in_transit",
  MD1: "out_for_delivery",
  AG1: "at_pickup_point",
  RE1: "returning",
  DI1: "delivered",
};

const text = (value: unknown): string | null => anyText(value, { numbers: false });
const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "runtime", epoch: "ms" });

/** An unknown product has no vocabulary: every code is reported rather than guessed. */
function mapCode(product: string, code: string | null): ParcelStatus | null {
  if (code === null) {
    return null;
  }
  const table = product === "colissimo" ? COLISSIMO : product === "chronopost" ? CHRONOPOST : {};
  return table[code] ?? null;
}

function eventCode(product: string, event: Json): string | null {
  return (
    (product === "colissimo" ? text(event["group"]) : text(event["code"])) ??
    text(event["statusCode"])
  );
}

function currentCode(product: string, events: readonly Json[], raw: Json): string | null {
  // Events arrive newest first.
  const newest = events[0] ?? {};
  if (product === "colissimo") {
    return text(asObject(raw["currentState"])["code"]) ?? text(newest["group"]);
  }
  // A return stays current while its legs add transport events, until a final delivery.
  const codes = events.map((e) => text(e["code"]));
  return codes.includes("RE1") && !codes.includes("DI1") ? "RE1" : text(newest["code"]);
}

/** One shipment as a snapshot; the carrier gives no delivery window. */
export function toSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const product = (text(raw["product"]) ?? "").toLowerCase();
  const events = (Array.isArray(raw["event"]) ? raw["event"].filter(isObject) : []).sort(
    (a, b) => (Date.parse(String(b["date"])) || 0) - (Date.parse(String(a["date"])) || 0),
  );
  const code = currentCode(product, events, raw);
  const unmapped = new Set<string>();
  if (code !== null && mapCode(product, code) === null) {
    unmapped.add(code);
  }
  const history: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["date"] ?? event["timestamp"]);
    const eCode = eventCode(product, event);
    if (eCode !== null && mapCode(product, eCode) === null) {
      unmapped.add(eCode);
    }
    const rawStatus = text(event["label"]) ?? text(event["description"]) ?? eCode;
    if (at !== null && rawStatus !== null) {
      history.push({ at, rawStatus, status: mapCode(product, eCode), location: null });
    }
  }
  unmapped.forEach(report);
  const status = mapCode(product, code);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus:
      text(asObject(raw["currentState"])["shortLabel"]) ?? text(events[0]?.["label"]) ?? code,
    delivered,
    deliveredAt: delivered ? isoTime(raw["deliveryDate"]) : null,
    pickup: status === "at_pickup_point",
    url: `https://www.laposte.fr/outils/suivre-vos-envois?code=${encodeURIComponent(barcode)}`,
    sender: text(asObject(raw["contextData"])["merchantName"]),
    history,
    raw,
  });
}
