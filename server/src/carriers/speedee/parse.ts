import {
  ruleStatus,
  cleanText,
  readTables,
  rulesTrackingUrl,
  snapshot,
  UnexpectedResponseError,
  zonedIso,
  type HtmlTable,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "speedee";

export function classify(value: string | null): ParcelStatus | null {
  const key = cleanText(value ?? "").toLowerCase();
  if (key === "") {
    return null;
  }
  return ruleStatus(CARRIER_ID, key);
}

/** The text without its per-scan tail, which may name a place. */
export function stem(value: string): string {
  return cleanText(value)
    .replace(/\s*[(:][\s\S]*$/, "")
    .trim();
}

const STAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)$/i;

/** The page shows US Central time as `MM/DD/YYYY hh:mm[:ss] AM`. */
export function centralTime(value: string): string | null {
  const match = STAMP.exec(cleanText(value));
  if (match === null) {
    return null;
  }
  const [, mo, d, y, h, mi, s, half] = match;
  const hour = (Number(h) % 12) + (half?.toUpperCase() === "PM" ? 12 : 0);
  return zonedIso(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour,
      minute: Number(mi),
      second: Number(s ?? 0),
    },
    "America/Chicago",
  );
}

function summary(tables: readonly HtmlTable[]): Map<string, string> {
  const table = tables.find((candidate) => candidate.classes.has("u-full-width"));
  if (table === undefined) {
    throw new UnexpectedResponseError("Spee-Dee page has no summary table.");
  }
  const found = new Map<string, string>();
  for (const row of table.rows) {
    const label = (row[0] ?? "").replace(/:$/, "").trim().toLowerCase();
    if (row.length >= 2 && label !== "") {
      if (found.has(label)) {
        throw new UnexpectedResponseError("Spee-Dee summary repeats a label.");
      }
      found.set(label, row[1] ?? "");
    }
  }
  return found;
}

const COLUMNS = ["date / time", "location", "activity"] as const;

interface Scan {
  readonly when: string;
  readonly where: string;
  readonly activity: string;
}

function progress(tables: readonly HtmlTable[]): Scan[] {
  const table = tables.find((candidate) => candidate.heading === "package progress");
  const header = table?.rows[0]?.map((cell) => cell.toLowerCase());
  if (table === undefined || header === undefined) {
    throw new UnexpectedResponseError("Spee-Dee page has no progress table.");
  }
  const [at, place, what] = COLUMNS.map((name) => header.indexOf(name));
  if (
    at === undefined ||
    place === undefined ||
    what === undefined ||
    [at, place, what].includes(-1)
  ) {
    throw new UnexpectedResponseError("Spee-Dee progress table lacks its columns.");
  }
  const scans: Scan[] = [];
  for (const row of table.rows.slice(1)) {
    if (row.every((cell) => cell === "")) {
      continue;
    }
    if (row.length !== header.length) {
      throw new UnexpectedResponseError("Spee-Dee progress row has the wrong width.");
    }
    scans.push({ when: row[at] ?? "", where: row[place] ?? "", activity: row[what] ?? "" });
  }
  return scans;
}

/**
 * Parses the package page. Fails closed: a page without both the summary and the progress table,
 * or without the Central-time footer, is rejected instead of giving a partial parcel.
 */
export function pageSnapshot(
  html: string,
  barcode: string,
  report: (text: string) => void,
): ParcelSnapshot {
  const page = readTables(html, "Spee-Dee");
  const facts = summary(page.tables);
  const summaryStatus = facts.get("status") ?? "";
  if (summaryStatus === "") {
    throw new UnexpectedResponseError("Spee-Dee summary has no status.");
  }
  if (!page.text.toLowerCase().includes("central time (usa)")) {
    throw new UnexpectedResponseError("Spee-Dee page no longer states its time zone.");
  }
  const scans = progress(page.tables);
  const history: SnapshotEvent[] = [];
  for (const scan of scans) {
    const at = centralTime(scan.when);
    if (at !== null) {
      history.push({
        at,
        status: classify(scan.activity),
        rawStatus: stem(scan.activity),
        location: scan.where === "" ? null : scan.where,
      });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let status = classify(summaryStatus);
  if (status === null) {
    report(stem(summaryStatus).toLowerCase().slice(0, 40));
    // The scans usually still say where the parcel is.
    status = history.find((event) => event.status !== null)?.status ?? null;
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: stem(summaryStatus),
    deliveredAt: delivered ? centralTime(facts.get("delivered on") ?? "") : null,
    url:
      rulesTrackingUrl(CARRIER_ID, barcode) ??
      `https://www.speedeedelivery.com/track/?tracking=${encodeURIComponent(barcode)}`,
    history,
    raw: { summaryStatus, scans },
  });
}
