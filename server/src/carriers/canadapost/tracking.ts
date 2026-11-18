import {
  asArray,
  asObject,
  isObject,
  joinParts,
  parseLocal,
  readJson,
  snapshot,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { DELIVERED_EVENT_CODE, mapEvent, resolveStatus } from "./status.js";

export const CARRIER_ID = "canadapost";
export const TRACKING_HOST = "www.canadapost-postescanada.ca";
export const PLAUSIBLE = /^[A-Z0-9]{10,40}$/i;

/** The route answers 406 to a plain JSON Accept and wants the page's own empty Basic header. */
const DETAIL_HEADERS = {
  authorization: "Basic Og==",
  referer: `https://${TRACKING_HOST}/track-reperage/en`,
  "x-requested-with": "XMLHttpRequest",
  accept: "application/vnd.cpc.trackweb-v1+json",
};

/** One PIN's detail; null when Canada Post has no history for it (an `error` in the body). */
export async function lookUp(http: PluginHttp, pin: string): Promise<Json | null> {
  const url = new URL(
    `https://${TRACKING_HOST}/track-reperage/rs/track/json/package/${encodeURIComponent(pin)}/detail`,
  );
  const response = await http.request(url, { headers: DETAIL_HEADERS });
  if (response.status !== 200 && response.status !== 206) {
    throw new TransientError(`Canada Post tracking answered HTTP ${response.status}.`);
  }
  const body = readJson(response, "Canada Post tracking");
  if (!isObject(body)) {
    throw new UnexpectedResponseError("Canada Post tracking did not answer with an object.");
  }
  if (body["error"] !== undefined && body["error"] !== null) {
    return null;
  }
  return "pin" in body ? body : null;
}

/** `{date, time, zoneOffset}`; without an offset the time is read in `zone`. */
function eventTime(event: Json, zone: string): string | null {
  const stamp = asObject(event["datetime"]);
  const date = text(stamp["date"]);
  if (date === null) {
    return null;
  }
  const time = /^(\d{2}):?(\d{2})(?::?(\d{2}))?/.exec(text(stamp["time"]) ?? "");
  const clock = time === null ? "00:00:00" : `${time[1]}:${time[2]}:${time[3] ?? "00"}`;
  const offset = text(stamp["zoneOffset"]);
  if (offset !== null && /^(Z|[+-]\d{2}:?\d{2})$/.test(offset)) {
    const parsed = new Date(`${date.slice(0, 10)}T${clock}${offset}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return parseLocal(`${date.slice(0, 10)}T${clock}`, zone);
}

interface Dated {
  readonly at: string | null;
  readonly event: Json;
}

function datedNewestFirst(detail: Json, zone: string): Dated[] {
  const dated = asArray(detail["events"])
    .filter(isObject)
    .map((event) => ({ at: eventTime(event, zone), event }));
  return [
    ...dated
      .filter((d) => d.at !== null)
      .sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? "")),
    ...dated.filter((d) => d.at === null),
  ];
}

function history(dated: readonly Dated[], lang: string): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const { at, event } of dated) {
    const rawStatus =
      text(event[lang === "fr" ? "descFr" : "descEn"]) ??
      text(event["descEn"]) ??
      text(event["cd"]);
    if (at !== null && rawStatus !== null) {
      const address = asObject(event["locationAddr"]);
      events.push({
        at,
        rawStatus,
        status: mapEvent(event),
        location: joinParts(text(address["city"]), text(address["regionCd"])),
      });
    }
  }
  return events;
}

function window(detail: Json, zone: string): { from: string | null; to: string | null } {
  const expected = asObject(detail["expectedDlvryDateTime"]);
  const day = text(expected["revisedDate"]) ?? text(expected["dlvryDate"]);
  if (day === null) {
    return { from: null, to: null };
  }
  const bounds = asObject(detail["expectedDlvryWindow"]);
  const at = (time: string | null) => parseLocal(`${day.slice(0, 10)}T${time ?? "00:00"}`, zone);
  const start = text(bounds["dlvryWindowStartTime"]);
  const end =
    text(bounds["dlvryWindowEndTime"]) ?? (bounds["dlvryWindowEOD"] === true ? "23:59" : null);
  return {
    from: at(start === null ? null : start.slice(0, 5)),
    to: end === null ? null : at(end.slice(0, 5)),
  };
}

function pickupPoint(dated: readonly Dated[]): string | null {
  for (const { event } of dated) {
    const name = text(event["retailNmEn"]);
    if (name !== null) {
      return joinParts(name, text(asObject(event["locationAddr"])["city"]));
    }
  }
  return null;
}

export interface Options {
  readonly zone: string;
  readonly lang: "en" | "fr";
}

export function toSnapshot(
  detail: Json,
  pin: string,
  options: Options,
  report: (code: string) => void,
): ParcelSnapshot {
  const dated = datedNewestFirst(detail, options.zone);
  const status = resolveStatus(
    detail,
    dated.map((d) => d.event),
    report,
  );
  const delivered = detail["delivered"] === true || status === "delivered";
  const planned = delivered ? { from: null, to: null } : window(detail, options.zone);
  const deliveredEvent = dated.find(
    (d) => d.at !== null && text(d.event["cd"]) === DELIVERED_EVENT_CODE,
  );
  return snapshot({
    carrier: CARRIER_ID,
    barcode: pin,
    status,
    rawStatus: text(detail["status"]),
    delivered,
    deliveredAt: delivered
      ? (deliveredEvent?.at ?? parseLocal(text(detail["actualDlvryDate"]), options.zone))
      : null,
    plannedFrom: planned.from,
    plannedTo: planned.to,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? pickupPoint(dated) : null,
    url: `https://${TRACKING_HOST}/track-reperage/${options.lang}#/details/${encodeURIComponent(pin)}`,
    sender: text(detail["custNm"]),
    history: history(dated, options.lang),
    raw: detail,
  });
}
