import {
  ruleStatus,
  asArray,
  asObject,
  epochIso,
  newestFirst,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "shopee_xpress";

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

const STRINGS = { numbers: false } as const;

/** SPX stamps in epoch seconds; zero and negative values mean "not set". */
function epochSeconds(value: unknown): string | null {
  return typeof value === "number" && value > 0 ? epochIso(value, "s") : null;
}

/** The coarse `milestone_code` of a tracking record ("milestone:" in the shared table). */
function milestone(record: Json): number | null {
  const code = record["milestone_code"];
  return typeof code === "number" ? code : null;
}

function mapRecord(record: Json): ParcelStatus | null {
  const code = milestone(record);
  return code === null ? null : ruleStatus(CARRIER_ID, `milestone:${String(code)}`);
}

function describe(record: Json): string | null {
  return (
    text(record["buyer_description"], STRINGS) ??
    text(record["description"], STRINGS) ??
    text(record["tracking_name"], STRINGS) ??
    text(record["tracking_code"], STRINGS)
  );
}

function records(raw: Json): Json[] {
  return asArray(asObject(raw["sls_tracking_info"])["records"]).map((record) => asObject(record));
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
  const entries: SnapshotEvent[] = [];
  for (const record of all) {
    const at = epochSeconds(record["actual_time"]);
    const rawStatus = describe(record);
    if (record["display_flag"] === 1 && at !== null && rawStatus !== null) {
      entries.push({ at, status: mapRecord(record), rawStatus, location: null });
    }
  }
  const history = newestFirst(entries);
  const delivered = status === "delivered";
  const estimate = asObject(raw["edd_info"]);
  const barcode = text(asObject(raw["order_info"])["spx_tn"], STRINGS) ?? requested;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: describe(newest),
    deliveredAt: delivered ? epochSeconds(newest["actual_time"]) : null,
    plannedFrom: delivered ? null : epochSeconds(estimate["edd_min"]),
    plannedTo: delivered ? null : epochSeconds(estimate["edd_max"]),
    receiver: text(asObject(raw["sls_tracking_info"])["receiver_name"], STRINGS),
    url: `https://${MARKETS[market].host}/track?${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
