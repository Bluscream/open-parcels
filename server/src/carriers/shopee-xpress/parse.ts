import type { ParcelStatus } from "../../domain/parcel.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "shopee-xpress";

/** Market → host and language code. Each host has been seen answering; none is guessed. */
export const MARKETS = {
  BR: { host: "spx.com.br", language: "br" },
  ID: { host: "spx.co.id", language: "en" },
  MY: { host: "spx.com.my", language: "ms" },
  PH: { host: "spx.ph", language: "en-ph" },
  TH: { host: "spx.co.th", language: "th" },
  VN: { host: "spx.vn", language: "en" },
} as const;
export type Market = keyof typeof MARKETS;
export const MARKET_IDS = Object.keys(MARKETS) as [Market, ...Market[]];

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** SPX stamps in epoch seconds. */
function epochSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/** The coarse `milestone_code` of a tracking record. 10 covers both legs of a return. */
const MILESTONES: Readonly<Record<number, ParcelStatus>> = {
  1: "registered",
  5: "in_transit",
  6: "out_for_delivery",
  8: "delivered",
  10: "returning",
};

function milestone(record: Json): number | null {
  const code = record["milestone_code"];
  return typeof code === "number" ? code : null;
}

function mapRecord(record: Json): ParcelStatus | null {
  const code = milestone(record);
  return code === null ? null : (MILESTONES[code] ?? null);
}

function describe(record: Json): string | null {
  return (
    text(record["buyer_description"]) ??
    text(record["description"]) ??
    text(record["tracking_name"]) ??
    text(record["tracking_code"])
  );
}

function records(raw: Json): Json[] {
  const list = asObject(raw["sls_tracking_info"])["records"];
  return Array.isArray(list) ? list.map(asObject) : [];
}

/** Turns one `data` block into a snapshot; `report` receives unmapped milestone codes. */
export function orderSnapshot(
  raw: Json,
  requested: string,
  market: Market,
  report: (code: string) => void,
): ParcelSnapshot {
  const all = records(raw);
  // The list is newest first; hidden records are internal steps without text.
  const newest = all[0] ?? {};
  const code = milestone(newest);
  const status = mapRecord(newest);
  if (code !== null && status === null) {
    report(String(code));
  }
  const history: SnapshotEvent[] = [];
  for (const record of all) {
    const at = epochSeconds(record["actual_time"]);
    const rawStatus = describe(record);
    if (record["display_flag"] === 1 && at !== null && rawStatus !== null) {
      history.push({ at, status: mapRecord(record), rawStatus, location: null });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const delivered = status === "delivered";
  const estimate = asObject(raw["edd_info"]);
  const barcode = text(asObject(raw["order_info"])["spx_tn"]) ?? requested;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: describe(newest),
    deliveredAt: delivered ? epochSeconds(newest["actual_time"]) : null,
    plannedFrom: delivered ? null : epochSeconds(estimate["edd_min"]),
    plannedTo: delivered ? null : epochSeconds(estimate["edd_max"]),
    receiver: text(asObject(raw["sls_tracking_info"])["receiver_name"]),
    url: `https://${MARKETS[market].host}/track?${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
