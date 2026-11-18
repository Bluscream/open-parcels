import {
  asArray,
  asObject,
  expectStatus,
  isObject,
  isoTime as kitIsoTime,
  newestFirst,
  parseLocal,
  readJson,
  ruleStatus,
  snapshot,
  text,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
/** Offset-less times are UTC; numbers are epoch milliseconds. */
const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "utc", epoch: "ms", keepFraction: true });

/** CTT Express (Spain) runs its own keyless tracker; it knows every all-digit code. */
export const EXPRESS_HOST = "wct.cttexpress.com";

/** A STATUS event code (the label is display text) from the shared table. */
const expressStatus = (code: string | null, report?: () => void): ParcelStatus | null =>
  code === null ? null : ruleStatus("ctt", `express:${code}`, report);

export function isExpressCode(code: string): boolean {
  return /^\d+$/.test(code);
}

/** The `shipping_history` for a code, or null when the tracker answers an empty body. */
export async function lookUpExpress(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`https://${EXPRESS_HOST}/p_track_redis_v2.php`);
  url.searchParams.set("sc", code);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  expectStatus(response, "CTT Express");
  if (response.body.trim() === "") {
    return null;
  }
  const body = readJson(response, "CTT Express");
  const history = asObject(asObject(body)["data"])["shipping_history"];
  if (!isObject(body) || (body["error"] !== null && body["error"] !== undefined)) {
    throw new UnexpectedResponseError("CTT Express reported an error.");
  }
  if (!isObject(history) || !Array.isArray(history["events"])) {
    throw new UnexpectedResponseError("CTT Express answered without events.");
  }
  return history;
}

/** The barcode is the configured code; the tracker echoes a different, longer one. */
export function expressSnapshot(
  raw: Json,
  code: string,
  report: (c: string) => void,
): ParcelSnapshot {
  const events = asArray(raw["events"])
    .filter(isObject)
    .map((event) => ({ event, at: isoTime(event["event_date"]) }))
    .sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
  // Only STATUS events carry the state; MANAGEMENTS record actions such as a new date.
  const statusEvents = events.filter(({ event }) => event["type"] === "STATUS");
  const newest = statusEvents.at(-1);
  const newestCode = newest === undefined ? null : text(newest.event["code"]);
  const status = expressStatus(newestCode, () => {
    report(newestCode ?? "");
  });
  const delivered = status === "delivered";
  const revised = events
    .filter(({ event }) => event["code"] === "71_INAT")
    .map(({ event }) => text(asObject(event["detail"])["delivery_date"]))
    .findLast((day) => day !== null);
  const planned =
    delivered || status === "returning" || revised === undefined
      ? null
      : parseLocal(revised, "Europe/Madrid");
  const history: SnapshotEvent[] = statusEvents.flatMap(({ event, at }) => {
    const rawStatus = text(event["description"]) ?? text(event["code"]);
    return at === null || rawStatus === null
      ? []
      : [
          {
            at,
            rawStatus,
            status: expressStatus(text(event["code"])),
            location: null,
          },
        ];
  });
  return snapshot({
    carrier: "ctt",
    barcode: code,
    status,
    rawStatus: newest === undefined ? null : text(newest.event["description"]),
    delivered,
    deliveredAt: delivered ? (newest?.at ?? null) : null,
    plannedFrom: planned,
    pickup: status === "at_pickup_point",
    pickupPoint:
      status === "at_pickup_point" && newest !== undefined
        ? text(asObject(newest.event["detail"])["delivery_location"])
        : null,
    url: `https://www.cttexpress.com/localizador-de-envios/?sc=${encodeURIComponent(code)}`,
    history: newestFirst(history),
    raw,
  });
}
