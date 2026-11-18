import type { ParcelStatus } from "../../domain/parcel.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "slovenska-posta";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

function offsetMinutes(utcMs: number): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Bratislava",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(utcMs))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** `localDate` is Slovak local time without an offset; a value with one is trusted. */
export function localDate(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const match = LOCAL_TIME.exec(raw);
  if (match === null) {
    const parsed = new Date(raw);
    return /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) && !Number.isNaN(parsed.getTime())
      ? parsed.toISOString()
      : null;
  }
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const guess = asUtc - offsetMinutes(asUtc) * 60_000;
  return new Date(asUtc - offsetMinutes(guess) * 60_000).toISOString();
}

/** The event `stateCode`. Both return codes are `returning`; the raw text keeps them apart. */
const STATE_MAP: Readonly<Record<string, ParcelStatus>> = {
  received: "registered",
  transit: "in_transit",
  notified: "at_pickup_point",
  delivered: "delivered",
  returning: "returning",
  returned: "returning",
};

function mapState(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATE_MAP[code] ?? null);
}

function rawStatus(event: Json): string | null {
  const code = text(event["stateCode"]);
  const detail = text(event["detailDescription"]) ?? text(event["detailCode"]);
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
  const events = Array.isArray(raw["events"]) ? raw["events"].map(asObject) : [];
  const dated: { at: string; event: Json }[] = [];
  for (const event of events) {
    const at = localDate(event["localDate"]);
    if (at !== null) {
      dated.push({ at, event });
    }
  }
  dated.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const history: SnapshotEvent[] = dated.map(({ at, event }) => ({
    at,
    status: mapState(text(event["stateCode"])),
    rawStatus: rawStatus(event) ?? "?",
    location: text(asObject(event["postOffice"])["name"]),
  }));
  const latest = dated[0];
  const code = latest === undefined ? null : text(latest.event["stateCode"]);
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
      atPoint && latest !== undefined ? text(asObject(latest.event["postOffice"])["name"]) : null,
    url: `https://www.posta.sk/en/tracking-of-items#parcel=${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
