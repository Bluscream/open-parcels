import {
  carrierPattern,
  expectStatus,
  rulesStatus,
  snapshot,
  text,
  UnexpectedResponseError,
  zonedIso,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { BOT_WALL_MARKERS, parsePage, type Page, type ScanRow } from "./page.js";

export const CARRIER_ID = "hrvatska_posta";
export const TRACKING_HOST = "posiljka.posta.hr";
const HOME_ZONE = "Europe/Zagreb";
const REDIRECTED_TO_LOCKER = "Pošiljka preusmjerena u paketomat";

/** Scans relayed from abroad lead with a UPU office code; single-zone countries only. */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  AT: "Europe/Vienna",
  BA: "Europe/Sarajevo",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  CH: "Europe/Zurich",
  CN: "Asia/Shanghai",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GR: "Europe/Athens",
  HK: "Asia/Hong_Kong",
  HU: "Europe/Budapest",
  IE: "Europe/Dublin",
  IL: "Asia/Jerusalem",
  IN: "Asia/Kolkata",
  IT: "Europe/Rome",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  LU: "Europe/Luxembourg",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  PL: "Europe/Warsaw",
  RO: "Europe/Bucharest",
  RS: "Europe/Belgrade",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  TH: "Asia/Bangkok",
  TR: "Europe/Istanbul",
  TW: "Asia/Taipei",
};

export const BARCODE_PATTERN = carrierPattern("hrvatska_posta");

export type Report = (kind: string, key: string) => void;

export function publicUrl(barcode: string): string {
  return `https://${TRACKING_HOST}/hr/tracking/trackingdata?barcode=${encodeURIComponent(barcode)}`;
}

/** The parsed page, or null when the carrier has no data for the code. */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Page | null> {
  const code = barcode.toUpperCase();
  const response = await http.request(new URL(publicUrl(code)), {
    headers: { accept: "text/html" },
    redirect: "manual",
    maxBytes: 512 * 1024,
  });
  expectStatus(response, "Hrvatska pošta tracking", 200);
  if (response.body.trim() === "") {
    throw new UnexpectedResponseError("Hrvatska pošta answered with an empty page.");
  }
  if (BOT_WALL_MARKERS.some((marker) => response.body.includes(marker))) {
    throw new UnexpectedResponseError("Hrvatska pošta answered with a bot-protection page.");
  }
  return parsePage(response.body, code);
}

function rowTime(row: ScanRow): string | null {
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(row.date ?? "");
  const clock = /^(\d{2}):(\d{2}):(\d{2})$/.exec(row.time ?? "");
  if (date === null || clock === null) {
    return null;
  }
  const country = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]\s/.exec(row.location ?? "")?.[1];
  const zone = (country === undefined ? undefined : COUNTRY_ZONES[country]) ?? HOME_ZONE;
  return zonedIso(
    {
      year: Number(date[3]),
      month: Number(date[2]),
      day: Number(date[1]),
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: Number(clock[3]),
    },
    zone,
  );
}

interface Walked {
  readonly at: string;
  readonly wording: string;
  readonly location: string | null;
  readonly status: ParcelStatus | null;
  readonly previous: ParcelStatus | null;
}

const MOVING = new Set<ParcelStatus>([
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
]);
const FORWARD_ONLY = new Set<ParcelStatus>(["delivered", "out_for_delivery", "at_pickup_point"]);

/**
 * Rows oldest to newest with a derived status. Seconds are shared between milestones, so ties
 * fall back to reverse page order. Once a return starts, later delivery or pickup scans belong
 * to the return leg; once the parcel moves, a later acceptance scan is transit.
 */
function walkRows(rows: readonly ScanRow[], report: Report): Walked[] {
  const dated = rows
    .map((row, index) => ({ row, index, at: rowTime(row) }))
    .filter(
      (entry): entry is { row: ScanRow & { wording: string }; index: number; at: string } =>
        entry.at !== null && entry.row.wording !== null,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || b.index - a.index);
  const walked: Walked[] = [];
  let returning = false;
  let moving = false;
  let previous: ParcelStatus | null = null;
  for (const { row, at } of dated) {
    // Keyed on the Croatian wording, whitespace collapsed (the English page merges two scans).
    const mapped = rulesStatus("hrvatska_posta", { code: row.wording })?.status ?? null;
    if (mapped === null) {
      report("wording", row.wording);
    }
    let status = mapped;
    if (status !== null && returning && FORWARD_ONLY.has(status)) {
      status = "returning";
    } else if (status === "registered" && moving) {
      status = "in_transit";
    }
    returning ||= status === "returning";
    moving ||= status !== null && MOVING.has(status);
    walked.push({ at, wording: row.wording, location: row.location, status, previous });
    previous = mapped ?? previous;
  }
  return walked;
}

function weightKg(weight: string | null): number | null {
  const grams = /^(\d+) g$/.exec(weight ?? "");
  return grams === null ? null : Number(grams[1]) / 1000;
}

export function trackingSnapshot(page: Page, report: Report): ParcelSnapshot {
  const walked = walkRows(page.rows, report);
  if (walked.length === 0) {
    throw new UnexpectedResponseError("Hrvatska pošta listed no readable scan rows.");
  }
  const mapped = walked.filter((entry) => entry.status !== null);
  const newest = mapped.at(-1);
  const status = newest?.status ?? null;
  const delivered = status === "delivered";
  const atPoint = mapped.filter((entry) => entry.status === "at_pickup_point").at(-1);
  const showPoint =
    status === "at_pickup_point" || (delivered && newest?.previous === "at_pickup_point");
  const headedForPoint =
    status !== "delivered" &&
    status !== "returning" &&
    walked.some(
      (entry) => entry.wording === REDIRECTED_TO_LOCKER || entry.status === "at_pickup_point",
    );
  const history: SnapshotEvent[] = walked
    .map((entry) => ({
      at: entry.at,
      rawStatus: entry.wording,
      status: entry.status,
      location: entry.location,
    }))
    .reverse();
  return snapshot({
    carrier: CARRIER_ID,
    barcode: page.number,
    status,
    rawStatus: walked.at(-1)?.wording ?? null,
    delivered,
    deliveredAt: delivered ? (newest?.at ?? null) : null,
    pickup: headedForPoint,
    // Office or locker name without its leading postcode.
    pickupPoint: showPoint ? text(atPoint?.location?.replace(/^\d{5}\s+/, "")) : null,
    url: publicUrl(page.number),
    weightKg: weightKg(page.weight),
    history,
    raw: page,
  });
}
