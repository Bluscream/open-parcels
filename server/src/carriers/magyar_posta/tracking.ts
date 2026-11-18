import {
  carrierPattern,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
  expectStatus,
  isObject,
  readObject,
  rulesStatus,
  text,
  zonedIso,
  type Json,
  type ParcelStatus,
  type PluginHttp,
} from "../../plugin/api.js";

export const CARRIER_ID = "magyar_posta";
export const TRACKING_HOST = "posta.hu";
const TIME_ZONE = "Europe/Budapest";

/** Scan categories ("bands") the carrier numbers 1 to 5; the shared table maps them. */
const DELIVERY_CATEGORY = "4";
const DELIVERED_CATEGORY = "5";

export const BARCODE_PATTERN = carrierPattern("magyar_posta");

export type Report = (kind: string, key: string) => void;

/** Returns the scan rows, newest first, or null when the code is unknown or not scanned yet. */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json[] | null> {
  const url = new URL(`https://${TRACKING_HOST}/szolgaltatasok/PostaWeb/TrackingInfo`);
  url.searchParams.set("ragszam", barcode);
  url.searchParams.set("language", "1");
  url.searchParams.set("registered", "true");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  expectStatus(response, "Magyar Posta tracking", 200);
  const payload = readObject(response, "Magyar Posta tracking");
  const values = Object.values(payload);
  const rows = payload[barcode] ?? (values.length === 1 ? values[0] : null);
  if (rows === null || rows === undefined) {
    return null;
  }
  if (!Array.isArray(rows)) {
    throw new UnexpectedResponseError("Magyar Posta scan rows are not a list.");
  }
  const objects = rows.filter(isObject);
  return objects.length === 0 ? null : objects;
}

/** Drops repeated scans; the delivered band reports one handover twice under two wordings. */
function uniqueRows(rows: readonly Json[]): Json[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const moment = `${text(row["tranzakcioValodiDatum"]) ?? ""} ${text(row["tranzakcioValodiIdopont"]) ?? ""}`;
    const category = text(row["tranzakcioKategoriaKod"]);
    const key =
      category === DELIVERED_CATEGORY
        ? moment
        : [
            moment,
            category,
            text(row["tranzakcioAzon"]),
            text(row["tranzakcioTipusLeirasSimple"]),
          ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mapRow(row: Json, report: Report): ParcelStatus | null {
  const category = text(row["tranzakcioKategoriaKod"]);
  if (category === null) {
    return null;
  }
  // The band, and in the delivery band the detail code (a counter or the courier's round).
  const detail = text(row["tranzakcioAzon"]) ?? "";
  const mapped = rulesStatus(CARRIER_ID, {
    fields: { category, ...(detail === "" ? {} : { detail }) },
  });
  if (category === DELIVERY_CATEGORY && mapped?.confirmed === false) {
    // Defaults to the courier reading, but an unknown hold must get a mapping soon.
    report("delivery_detail", detail === "" ? "(empty)" : detail);
  }
  if (mapped === null) {
    report("category", category);
    return null;
  }
  return mapped.status;
}

/** The epoch milliseconds are unambiguous; the local date and time pair is the fallback. */
function rowTime(row: Json): string | null {
  const epoch = row["time"];
  if (typeof epoch === "number" && Number.isFinite(epoch)) {
    return new Date(epoch).toISOString();
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(text(row["tranzakcioValodiDatum"]) ?? "");
  if (date === null) {
    return null;
  }
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(
    text(row["tranzakcioValodiIdopont"]) ?? "00:00:00",
  );
  return zonedIso(
    {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: Number(clock?.[1] ?? 0),
      minute: Number(clock?.[2] ?? 0),
      second: Number(clock?.[3] ?? 0),
    },
    TIME_ZONE,
  );
}

function office(row: Json): string | null {
  return text(row["postaNev"])?.split("|")[0]?.trim() ?? null;
}

/** The newest row that states a weight wins; weights are whole grams. */
function weightKg(rows: readonly Json[]): number | null {
  for (const row of rows) {
    const grams = text(row["suly"]);
    if (grams !== null && /^\d+$/.test(grams)) {
      return Number(grams) / 1000;
    }
  }
  return null;
}

/** Turns the scan rows (newest first) into a snapshot; `report` receives unmapped codes. */
export function trackingSnapshot(
  barcode: string,
  rawRows: readonly Json[],
  report: Report,
): ParcelSnapshot {
  const rows = uniqueRows(rawRows);
  const mapped = rows.map((row) => ({ row, status: mapRow(row, report) }));
  // The newest row that maps decides; an unknown newer category falls back to older rows.
  const current = mapped.find((entry) => entry.status !== null);
  const status = current?.status ?? null;
  const newest = rows[0];
  const history: SnapshotEvent[] = [];
  for (const { row, status: rowStatus } of mapped) {
    const at = rowTime(row);
    const rawStatus =
      text(row["tranzakcioTipusLeirasSimple"]) ?? text(row["tranzakcioKategoriaKod"]);
    if (at !== null && rawStatus !== null) {
      history.push({ at, rawStatus, status: rowStatus, location: office(row) });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus:
      newest === undefined
        ? null
        : (text(newest["tranzakcioTipusLeirasSimple"]) ?? text(newest["tranzakcioKategoriaKod"])),
    delivered,
    deliveredAt: delivered && current !== undefined ? rowTime(current.row) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" && current !== undefined ? office(current.row) : null,
    weightKg: weightKg(rows),
    history,
    raw: { rows: rawRows },
  });
}
