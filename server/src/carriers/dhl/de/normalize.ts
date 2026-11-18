import {
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  objects,
  num,
  textOf,
  unescapeHtml,
  isoTime,
  localDay,
  epoch,
  rulesStatus,
} from "../../../plugin/api.js";
import { BERLIN, germanTrackingUrl } from "../constants.js";
import { asObject, asString, type Json } from "../util.js";

type Deps = Pick<PluginContext<unknown, unknown>, "reportUnknown">;

const INCOMING = new Set(["ANKOMMEND", "EINGEHEND"]);
const OUTGOING = new Set(["ABGEHEND", "AUSGEHEND"]);
/** Keys in `raw` that could open a locker or show the courier near the address. */
const DROP_FROM_RAW = /abholcode(?!available)|pin$|liveTracking/i;

/** `fortschritt` is a 0..max ladder; the shared table maps it as `fortschritt:<n>`. */
function ladderStatus(deps: Deps, verlauf: Json): ParcelSnapshot["status"] {
  const value = num(verlauf["fortschritt"], { strings: false });
  const maximum = num(verlauf["maximalFortschritt"], { strings: false }) ?? 5;
  if (value === null) {
    return null;
  }
  if (maximum !== 5) {
    deps.reportUnknown("de_maximal_fortschritt", String(maximum));
  }
  if (value >= maximum && maximum > 0) {
    return "delivered";
  }
  const mapped = rulesStatus("dhl", { code: `fortschritt:${value}` });
  if (mapped === null) {
    deps.reportUnknown("de_fortschritt", String(value));
  }
  return mapped?.status ?? null;
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const entries: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["datum"], { naive: { zone: BERLIN } });
    const html = asString(event["status"]);
    if (at !== null && html !== null) {
      const text = textOf(html);
      entries.push({
        at,
        status: rulesStatus("dhl", { text })?.status ?? null,
        rawStatus: text,
        location: null,
      });
    }
  }
  return entries.sort((a, b) => epoch(a.at) - epoch(b.at));
}

/** The location named by the link in the newest status text ("ready at Packstation …"). */
function pickupPointFrom(events: readonly Json[]): string | null {
  const latest = [...events].sort(
    (a, b) =>
      epoch(isoTime(b["datum"], { naive: { zone: BERLIN } })) -
      epoch(isoTime(a["datum"], { naive: { zone: BERLIN } })),
  )[0];
  const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(asString(latest?.["status"]) ?? "");
  return anchor?.[1] === undefined ? null : textOf(anchor[1]) || null;
}

function window(zustellung: Json): { from: string | null; to: string | null } {
  let from = isoTime(zustellung["zustellzeitfensterVon"], { naive: { zone: BERLIN } });
  let to = isoTime(zustellung["zustellzeitfensterBis"], { naive: { zone: BERLIN } });
  if (from === null && to === null) {
    from =
      isoTime(zustellung["zustellzeitfenster"], { naive: { zone: BERLIN } }) ??
      isoTime(zustellung["zustelldatum"], { naive: { zone: BERLIN } });
  }
  if (from !== null && to === null) {
    to = localDay(from, BERLIN)?.to ?? null;
  }
  return { from, to };
}

function stripRaw(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRaw);
  }
  const object = asObject(value);
  if (object === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key, item]) => typeof item === "boolean" || !DROP_FROM_RAW.test(key))
      .map(([key, item]) => [key, stripRaw(item)]),
  );
}

function receiverOf(name: string | null, addressee: string | null): string | null {
  const value = name ?? addressee;
  return value === null ? null : unescapeHtml(value);
}

/** One `sendungen` entry of the German account. */
export function normalizeDe(deps: Deps, element: Json): ParcelSnapshot | null {
  const barcode = asString(element["id"]);
  if (barcode === null) {
    return null;
  }
  const info = asObject(element["sendungsinfo"]) ?? {};
  const details = asObject(element["sendungsdetails"]) ?? {};
  const verlauf = asObject(details["sendungsverlauf"]) ?? {};
  const zustellung = asObject(details["zustellung"]) ?? {};
  const events = objects(verlauf["events"]);
  const richtung = asString(info["sendungsrichtung"])?.toUpperCase() ?? null;
  if (richtung !== null && !INCOMING.has(richtung) && !OUTGOING.has(richtung)) {
    deps.reportUnknown("de_sendungsrichtung", richtung);
  }
  const outgoing = richtung !== null && OUTGOING.has(richtung);
  const incoming = richtung !== null && INCOMING.has(richtung);
  const name = asString(info["sendungsname"]);
  const addressee = asString(asObject(details["panEmpfaenger"])?.["name"]);

  // The ladder is only confirmed for incoming parcels; outgoing ones fall back to the texts.
  const ladder = outgoing ? null : ladderStatus(deps, verlauf);
  const flag = details["istZugestellt"];
  const delivered = typeof flag === "boolean" ? flag : ladder === "delivered";
  let status: ParcelSnapshot["status"] = delivered ? "delivered" : ladder;
  const texts = history(events);
  status ??= texts.findLast((e) => e.status !== null)?.status ?? null;

  let pickupPoint: string | null = null;
  const station = asString(zustellung["packageStationType"]);
  if (
    !delivered &&
    status === "out_for_delivery" &&
    station?.startsWith("PACKAGE_STATION") === true &&
    zustellung["abholcodeAvailable"] === true
  ) {
    status = "at_pickup_point";
    pickupPoint = pickupPointFrom(events);
  }
  if (details["retoure"] === true || details["ruecksendung"] === true) {
    status = "returning";
  }
  const planned = delivered ? { from: null, to: null } : window(zustellung);
  const rawStatus = asString(verlauf["status"]) ?? asString(verlauf["kurzStatus"]);

  return snapshot({
    carrier: "dhl",
    barcode,
    direction: outgoing ? "outgoing" : "incoming",
    status,
    rawStatus: rawStatus === null ? null : textOf(rawStatus),
    delivered,
    deliveredAt: delivered
      ? isoTime(verlauf["datumAktuellerStatus"], { naive: { zone: BERLIN } })
      : null,
    plannedFrom: planned.from,
    plannedTo: planned.to,
    pickup: status === "at_pickup_point",
    pickupPoint,
    url: germanTrackingUrl(barcode),
    // `sendungsname` names the other party: the sender of an incoming parcel, the recipient of
    // an outgoing one. With no known direction it is left out rather than guessed.
    sender: incoming && name !== null ? unescapeHtml(name) : null,
    receiver: receiverOf(outgoing ? name : null, addressee),
    history: texts,
    raw: stripRaw(element),
  });
}
