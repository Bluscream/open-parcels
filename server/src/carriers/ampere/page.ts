import {
  isoTime,
  newestFirst,
  snapshot,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type SnapshotEvent,
  type StatusTable,
  unescapeHtml,
} from "../../plugin/api.js";

export const CARRIER_ID = "ampere";
const ZONE = "Europe/Amsterdam";

/**
 * Both wordings the page uses: the banner and the history log phrase the "sorted" stage
 * differently, so both are listed.
 */
export const AMPERE_STATUS: StatusTable = {
  "Pakket is aangemeld maar nog niet ontvangen door Ampère": "registered",
  "Pakket is klaar voor bezorging": "in_transit",
  "Pakket is gesorteerd": "in_transit",
  "Bezorger is onderweg": "out_for_delivery",
  "Pakket is bezorgd": "delivered",
};

const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
/** "Wo 12 aug 21:16": weekday, day, month, time. No year. */
const HISTORY_TIME = /^[A-Za-z]{2}\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/;

const decode = (value: string): string => unescapeHtml(value).trim();

/** Text of every element with this `data-test-id`, in page order. */
export function allById(html: string, id: string): string[] {
  const pattern = new RegExp(`data-test-id="${id}"[^>]*>\\s*([^<]*?)\\s*<`, "g");
  return [...html.matchAll(pattern)]
    .map((match) => decode(match[1] ?? ""))
    .filter((value) => value !== "");
}

const firstById = (html: string, id: string): string | null => allById(html, id)[0] ?? null;

/**
 * The page omits the year: take the current one in Amsterdam, and the year before when that
 * would put the entry more than a day in the future (a late-December entry seen in January).
 */
export function historyTime(value: string, now: Date): string | null {
  const match = HISTORY_TIME.exec(value.trim());
  const month = MONTHS.indexOf((match?.[2] ?? "").toLowerCase()) + 1;
  if (match === null || month === 0) {
    return null;
  }
  const wall = (year: number) =>
    zonedIso(
      { year, month, day: Number(match[1]), hour: Number(match[3]), minute: Number(match[4]) },
      ZONE,
    );
  const year = Number(
    new Intl.DateTimeFormat("en", { timeZone: ZONE, year: "numeric" }).format(now),
  );
  const candidate = wall(year);
  if (candidate !== null && Date.parse(candidate) > now.getTime() + 24 * 60 * 60 * 1000) {
    return wall(year - 1);
  }
  return candidate;
}

export interface PageInput {
  readonly html: string;
  readonly parcelToken: string;
  readonly window: Json;
  readonly now: Date;
}

export function ampereSnapshot(input: PageInput, report: (text: string) => void): ParcelSnapshot {
  const statuses = allById(input.html, "history-entry-status");
  const times = allById(input.html, "history-entry-time");
  const banner = firstById(input.html, "status-text");
  // History entries are newest first and more complete than the banner, so they win.
  const current = statuses[0] ?? banner;
  for (const value of [
    ...statuses,
    ...(statuses.length === 0 && banner !== null ? [banner] : []),
  ]) {
    if (AMPERE_STATUS[value] === undefined) {
      report(value);
    }
  }
  const status = current === null ? null : (AMPERE_STATUS[current] ?? null);
  const history: SnapshotEvent[] = [];
  statuses.forEach((rawStatus, index) => {
    const at = historyTime(times[index] ?? "", input.now);
    if (at !== null) {
      history.push({ at, rawStatus, status: AMPERE_STATUS[rawStatus] ?? null, location: null });
    }
  });
  const delivered = status === "delivered";
  const barcode = firstById(input.html, "barcode-value") ?? input.parcelToken;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: current,
    delivered,
    deliveredAt: delivered ? historyTime(times[0] ?? "", input.now) : null,
    plannedFrom: delivered ? null : isoTime(input.window["from"], { naive: { zone: ZONE } }),
    plannedTo: delivered ? null : isoTime(input.window["to"], { naive: { zone: ZONE } }),
    sender: firstById(input.html, "company-name-value") ?? "bol.com",
    receiver: firstById(input.html, "receiver-name"),
    history: newestFirst(history),
    // The page itself is not kept: it holds the address. The parcel token opens nothing alone.
    raw: { barcode, statuses, times, banner, window: input.window },
  });
}
