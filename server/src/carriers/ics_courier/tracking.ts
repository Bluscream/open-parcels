import {
  carrierPattern,
  expectStatus,
  rulesStatus,
  snapshot,
  text,
  unescapeHtml,
  UnexpectedResponseError,
  zonedIso,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "ics_courier";
export const TRACKING_HOST = "www1.icscourier.ca";
const SOAP_NAMESPACE = "http://www.icscourier.ca/";
const SOAP_ACTION = `${SOAP_NAMESPACE}TracePackgeWithSequence`;
/** Times carry no offset; the carrier works in Eastern Canada. */
const TIME_ZONE = "America/Toronto";

export const BARCODE_PATTERN = carrierPattern("ics_courier");

export type Report = (kind: string, key: string) => void;
export type IcsRecord = Readonly<Record<string, string>>;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function envelope(barcode: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
    `<TracePackgeWithSequence xmlns="${SOAP_NAMESPACE}">` +
    `<TrackNums><string>${escapeXml(barcode)}</string></TrackNums>` +
    "<DetailInfo>false</DetailInfo></TracePackgeWithSequence></soap:Body></soap:Envelope>"
  );
}

const PREFIX = String.raw`(?:[\w.-]+:)?`;
/** The innermost record element: the response nests the record name inside itself. */
const RECORD = new RegExp(
  String.raw`<${PREFIX}TrackingInfoWithSeq(?:\s[^>]*)?>((?:(?!<${PREFIX}TrackingInfoWithSeq[\s>/]).)*?)</${PREFIX}TrackingInfoWithSeq>`,
  "gs",
);
const LEAF = new RegExp(String.raw`<${PREFIX}(\w+)(?:\s[^>]*)?>([^<]*)</${PREFIX}\1>`, "g");

/** The flat records of a SOAP answer in document order; a fault or DTD stops the run. */
export function parseRecords(body: string): IcsRecord[] {
  if (/<!DOCTYPE/i.test(body)) {
    throw new UnexpectedResponseError("ICS Courier answered with a DTD.");
  }
  if (new RegExp(`<${PREFIX}Fault[\\s>]`).test(body)) {
    throw new UnexpectedResponseError("ICS Courier answered with a SOAP fault.");
  }
  if (!new RegExp(`<${PREFIX}Envelope[\\s>]`).test(body)) {
    throw new UnexpectedResponseError("ICS Courier did not answer with a SOAP envelope.");
  }
  const records: IcsRecord[] = [];
  for (const match of body.matchAll(RECORD)) {
    const fields: Record<string, string> = {};
    for (const leaf of (match[1] ?? "").matchAll(LEAF)) {
      fields[leaf[1] ?? ""] = unescapeHtml(leaf[2] ?? "").trim();
    }
    if (Object.keys(fields).length > 0) {
      records.push(fields);
    }
  }
  return records;
}

function isNotFound(record: IcsRecord): boolean {
  return (record["Status"] ?? "").trim().toLowerCase() === "not found" && !record["Code"];
}

/** The records for one code, or null when the carrier reports it as not found. */
export async function lookUp(http: PluginHttp, barcode: string): Promise<IcsRecord[] | null> {
  const response = await http.request(
    new URL(`https://${TRACKING_HOST}/icsapicnswebservice/service.asmx`),
    {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8", soapaction: `"${SOAP_ACTION}"` },
      body: envelope(barcode),
      maxBytes: 512 * 1024,
    },
  );
  expectStatus(response, "ICS Courier tracking", 200);
  const records = parseRecords(response.body);
  if (records.length === 0) {
    throw new UnexpectedResponseError("ICS Courier answered without a tracking record.");
  }
  const events = records.filter((record) => !isNotFound(record));
  return events.length === 0 ? null : events;
}

/** ISO for a time with or without an offset; times without one are Eastern Canadian. */
function recordTime(value: string | undefined): string | null {
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(
    value ?? "",
  );
  if (local !== null) {
    return zonedIso(
      {
        year: Number(local[1]),
        month: Number(local[2]),
        day: Number(local[3]),
        hour: Number(local[4]),
        minute: Number(local[5]),
        second: Number(local[6] ?? 0),
      },
      TIME_ZONE,
    );
  }
  const parsed = Date.parse(value ?? "");
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value ?? "") && !Number.isNaN(parsed)
    ? new Date(parsed).toISOString()
    : null;
}

/**
 * The free text reads like "Delivered at: <name> <address>", so only the words before the colon
 * are kept; without a colon the opaque code stands in rather than the text.
 */
function describe(record: IcsRecord): string | null {
  const status = record["Status"] ?? "";
  const code = text(record["Code"]);
  if (status.includes(":")) {
    const head = (status.split(":")[0] ?? "").trim().replace(/\s+at$/i, "");
    return text(head) ?? code;
  }
  return code;
}

function sequence(record: IcsRecord): number {
  const value = Number.parseInt(record["Sequence"] ?? "", 10);
  return Number.isNaN(value) ? 0 : value;
}

/** Oldest to newest by sequence, then time; exact repeats dropped. */
function ordered(records: readonly IcsRecord[]): IcsRecord[] {
  const seen = new Set<string>();
  const unique = records.filter((record) => {
    const key = [record["Sequence"], record["Code"], record["StatusDate"]].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const time = (record: IcsRecord): number => {
    const iso = recordTime(record["StatusDate"]);
    return iso === null ? Number.NEGATIVE_INFINITY : Date.parse(iso);
  };
  return unique.sort((a, b) => sequence(a) - sequence(b) || time(a) - time(b));
}

export function trackingSnapshot(
  barcode: string,
  records: readonly IcsRecord[],
  report: Report,
): ParcelSnapshot {
  const events = ordered(records);
  const reported = new Set<string>();
  const mapCode = (code: string | undefined): ParcelStatus | null => {
    const key = code === undefined || code === "" ? "(empty)" : code;
    // Only the delivered code has been seen and confirmed; everything else is reported.
    const status = rulesStatus("ics_courier", { code: key })?.status ?? null;
    if (status === null && !reported.has(key)) {
      reported.add(key);
      report("status_code", key);
    }
    return status;
  };
  const history: SnapshotEvent[] = [];
  for (const record of events) {
    const at = recordTime(record["StatusDate"]);
    const rawStatus = describe(record);
    if (at !== null && rawStatus !== null) {
      history.push({ at, rawStatus, status: mapCode(record["Code"]), location: null });
    }
  }
  history.reverse();
  const latest = events.at(-1);
  const status = latest === undefined ? null : mapCode(latest["Code"]);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest === undefined ? null : describe(latest),
    delivered,
    deliveredAt: delivered ? recordTime(latest?.["StatusDate"]) : null,
    history,
    raw: { records },
  });
}
