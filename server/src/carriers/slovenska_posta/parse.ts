import {
  ruleStatus,
  asArray,
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

export const CARRIER_ID = "slovenska_posta";

/** The API's fields are strings; a number is never read as text. */
export const STRINGS = { numbers: false } as const;

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** `localDate` is Slovak local time without an offset; a value with one is trusted. */
export function localDate(value: unknown): string | null {
  const raw = text(value, STRINGS);
  if (raw === null) {
    return null;
  }
  if (LOCAL_TIME.test(raw)) {
    return isoTime(raw, { naive: { zone: "Europe/Bratislava" } });
  }
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
    ? isoTime(raw, { naive: { zone: "Europe/Bratislava" } })
    : null;
}

/** The event `stateCode`. Both return codes are `returning`; the raw text keeps them apart. */
function mapState(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

function rawStatus(event: Json): string | null {
  const code = text(event["stateCode"], STRINGS);
  const detail = text(event["detailDescription"], STRINGS) ?? text(event["detailCode"], STRINGS);
  return code !== null && detail !== null && detail !== code
    ? `${code}: ${detail}`
    : (code ?? detail);
}

/** Turns one `results[]` entry into a snapshot; `report` receives unmapped state codes. */
export function resultSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = asArray(raw["events"]).map((event) => asObject(event));
  const found: { at: string; event: Json }[] = [];
  for (const event of events) {
    const at = localDate(event["localDate"]);
    if (at !== null) {
      found.push({ at, event });
    }
  }
  const dated = newestFirst(found);
  const history: SnapshotEvent[] = dated.map(({ at, event }) => ({
    at,
    status: mapState(text(event["stateCode"], STRINGS)),
    rawStatus: rawStatus(event) ?? "?",
    location: text(asObject(event["postOffice"])["name"], STRINGS),
  }));
  const latest = dated[0];
  const code = latest === undefined ? null : text(latest.event["stateCode"], STRINGS);
  const status = mapState(code);
  if (code !== null && status === null) {
    report(code);
  }
  const atPoint = status === "at_pickup_point";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest === undefined ? null : rawStatus(latest.event),
    deliveredAt: status === "delivered" ? (latest?.at ?? null) : null,
    pickup: atPoint,
    pickupPoint:
      atPoint && latest !== undefined
        ? text(asObject(latest.event["postOffice"])["name"], STRINGS)
        : null,
    url: `https://www.posta.sk/en/tracking-of-items#parcel=${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
