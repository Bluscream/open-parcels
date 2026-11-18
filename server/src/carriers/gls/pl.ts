import {
  asArray as asList,
  isObject,
  parseJsonBody,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID, isoTime, latestHistory, mapGls, text } from "./shared.js";

export const PL_HOST = "mygls.gls-poland.com.pl";
/** The carrier's own "unknown number" answer, sent with HTTP 400. */
const UNKNOWN_PARCEL = "mygls-tracking-400(111)";

/** The keyless national lookup, by number alone; it carries the full event history. */
export async function lookUpPl(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${PL_HOST}/api/v1/mygls-tracking/public/tracking/shipment/track/${encodeURIComponent(barcode)}`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  const body = parseJsonBody(response.body);
  if (!isObject(body)) {
    throw new UnexpectedResponseError(`GLS Poland answered HTTP ${response.status} without JSON.`);
  }
  if (response.status === 400 && body["code"] === UNKNOWN_PARCEL) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`GLS Poland answered HTTP ${response.status}.`);
  }
  return body;
}

/** Polish event names, matched exactly (NFC): "niedoręczona" contains "doręczona". */
function eventStatus(name: string | null): ReturnType<typeof mapGls> {
  return name === null ? null : mapGls(null, name.normalize("NFC"));
}

export function plSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const rows = asList(raw["eventReasons"]).filter(isObject);
  const events = latestHistory(
    rows.flatMap((row) => {
      const at = isoTime(row["packageStatusDate"]);
      const name = text(row["packageStatusName"]);
      const rawStatus = text(row["packageStatusDescription"]) ?? name;
      return at === null || rawStatus === null
        ? []
        : [{ at, rawStatus, status: eventStatus(name)?.status ?? null, location: null }];
    }),
  );
  const ident = text(raw["progressBarIdent"])?.toUpperCase() ?? null;
  const mapped = mapGls(ident);
  if (ident !== null && mapped === null) {
    report(ident);
  }
  const status = mapped?.status ?? events.find((event) => event.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const number = text(raw["parcelNumber"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: number,
    status,
    rawStatus: events[0]?.rawStatus ?? text(raw["progressBar"]) ?? ident,
    delivered,
    deliveredAt: delivered ? (isoTime(raw["stateDate"]) ?? events[0]?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    url: `https://gls-group.com/PL/en/parcel-tracking/?match=${encodeURIComponent(number)}`,
    history: events,
    raw,
  });
}
