import type { ParcelStatus } from "../../plugin/api.js";
import {
  ruleStatus,
  cleanText,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { readPage, type Cell } from "./html.js";

export const CARRIER_ID = "straightship";

/** Drops the "(City, ST)" suffix and the contact address, which may be personal. */
export function normalise(sentence: string): string {
  return cleanText(sentence)
    .replace(/\s*\([^()]*,\s*[A-Za-z]{2}\)\s*$/, "")
    .replace(/(please e-mail ).+?( to make arrangement)/, "$1<address>$2");
}

function mapSentence(sentence: string | null): ParcelStatus | null {
  return sentence === null || sentence === "" ? null : ruleStatus(CARRIER_ID, normalise(sentence));
}

/** The carrier states its times are UTC: `YYYY-MM-DD HH:MM:SS`. */
function utcTime(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(cleanText(value));
  return match === null
    ? null
    : `${match.slice(1, 4).join("-")}T${match.slice(4, 7).join(":")}.000Z`;
}

const LABELS: Readonly<Record<string, string>> = {
  "tracking id": "trackingId",
  "package status": "packageStatus",
};

/** The summary is laid out either label-then-value per row, or labels over values. */
function summary(tables: readonly Cell[][][]): Map<string, string> {
  const found = new Map<string, string>();
  for (const rows of tables) {
    rows.forEach((row, index) => {
      row.forEach((cell, position) => {
        const key = cell.header ? LABELS[cell.text.toLowerCase()] : undefined;
        if (key === undefined || found.has(key)) {
          return;
        }
        const next = row[position + 1];
        const below = rows[index + 1]?.[position];
        const value = next !== undefined && !next.header ? next : below;
        if (value !== undefined && !value.header) {
          found.set(key, value.text);
        }
      });
    });
  }
  return found;
}

interface Row {
  readonly when: string;
  readonly sentence: string;
}

function history(tables: readonly Cell[][][]): Row[] | null {
  for (const rows of tables) {
    const header = (rows[0] ?? [])
      .filter((cell) => cell.header)
      .map((cell) => cell.text.toLowerCase());
    if (header.join("|") !== "timestamp|status|city") {
      continue;
    }
    return rows.slice(1).flatMap((row) => {
      const cells = row.filter((cell) => !cell.header).map((cell) => cell.text);
      return cells.length >= 2 ? [{ when: cells[0] ?? "", sentence: cells[1] ?? "" }] : [];
    });
  }
  return null;
}

/**
 * Parses the tracking reply. Returns null for the carrier's "no results" answer; anything else
 * without both the summary and the history table is rejected.
 */
export function pageSnapshot(
  html: string,
  barcode: string,
  report: (text: string) => void,
): ParcelSnapshot | null {
  const page = readPage(html);
  const facts = summary(page.tables);
  const rows = history(page.tables);
  const trackingId = facts.get("trackingId");
  const packageStatus = facts.get("packageStatus");
  if (trackingId === undefined || packageStatus === undefined) {
    if (html.includes("No results found!")) {
      return null;
    }
    throw new UnexpectedResponseError("Straightship reply has no summary table.");
  }
  if (rows === null) {
    throw new UnexpectedResponseError("Straightship reply has no history table.");
  }
  if (trackingId.toUpperCase() !== barcode.toUpperCase()) {
    throw new UnexpectedResponseError("Straightship answered for a different tracking id.");
  }
  const events: SnapshotEvent[] = [];
  for (const row of rows) {
    const at = utcTime(row.when);
    if (at !== null && row.sentence !== "") {
      events.push({
        at,
        status: mapSentence(row.sentence),
        rawStatus: normalise(row.sentence),
        location: null,
      });
    }
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let status = mapSentence(packageStatus);
  if (status === null && packageStatus !== "") {
    report(normalise(packageStatus).slice(0, 60));
    status = events.find((event) => event.status !== null)?.status ?? null;
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: packageStatus === "" ? null : normalise(packageStatus),
    deliveredAt: delivered
      ? (events.find((event) => event.status === "delivered")?.at ?? null)
      : null,
    url: `https://straightship.com/track-your-shipment/tracking-id/${encodeURIComponent(barcode.toUpperCase())}/`,
    history: events,
    raw: { packageStatus, history: rows },
  });
}
