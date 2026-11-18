import {
  asArray as asList,
  asObject,
  carrierKey,
  isObject,
  parseJsonBody,
  snapshot,
  TransientError,
  unescapeHtml,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  CARRIER_ID,
  compactPostcode,
  latestHistory,
  localTime,
  mapGls,
  publicUrl,
  text,
  type GroupCountry,
} from "./shared.js";

/** The web tracker's fixed client id (in the shared rules); nothing issues it per user. */
const caller = (): string => carrierKey("gls", "group_caller");

interface Reply {
  readonly status: number;
  readonly body: Json;
}

/**
 * One GET against the group service. Its maintenance page is an HTML 200, so a body that is not
 * a JSON object stops the run instead of reading as "not found".
 */
async function getJson(http: PluginHttp, url: URL): Promise<Reply> {
  const response = await http.request(url, { headers: { accept: "application/json" } });
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError(
      `GLS group tracking answered HTTP ${response.status} without a JSON object.`,
    );
  }
  return { status: response.status, body: payload };
}

function base(country: GroupCountry, path: string): URL {
  return new URL(`https://${country.host}/app/service/open/rest/${country.locale}/${path}`);
}

/**
 * The parcel-number-only overview. Used when the detailed lookup rejects the postcode (E609) or
 * does not index the code (E800). The lookup type is retried once with the other value on a 5xx
 * or an E206, because some non-numeric codes need it.
 */
async function overview(
  http: PluginHttp,
  millis: number,
  country: GroupCountry,
  barcode: string,
): Promise<Json | null> {
  const types = [country.preferredType, country.preferredType === "NAT" ? "" : "NAT"];
  for (const [attempt, type] of types.entries()) {
    const url = base(country, "rstt029");
    url.search = new URLSearchParams({
      match: barcode,
      type,
      caller: caller(),
      millis: String(millis),
    }).toString();
    const { status, body } = await getJson(http, url);
    const lastError = text(body["lastError"]);
    const retry = status >= 500 || (status === 404 && lastError === "E206");
    if (retry && attempt < types.length - 1) {
      continue;
    }
    if (status >= 500) {
      throw new TransientError(`GLS group tracking answered HTTP ${status}.`);
    }
    if (lastError !== null) {
      return null;
    }
    const first = asList(body["tuStatus"])[0];
    return isObject(first) ? first : null;
  }
  return null;
}

/**
 * Looks one code up: the detailed lookup first (history and weight, needs the delivery
 * postcode), then the overview when the detailed one cannot answer for this code.
 */
export async function lookUpGroup(
  http: PluginHttp,
  millis: number,
  country: GroupCountry,
  barcode: string,
  postcode: string,
): Promise<Json | null> {
  const url = base(country, `rstt028/${encodeURIComponent(barcode)}`);
  url.search = new URLSearchParams({
    caller: caller(),
    millis: String(millis),
    tuOwnerCode: "",
    postalCode: compactPostcode(postcode),
  }).toString();
  const { status, body } = await getJson(http, url);
  const lastError = text(body["lastError"]);
  if (lastError === "E609" || lastError === "E800") {
    return overview(http, millis, country, barcode);
  }
  if (lastError !== null) {
    return null;
  }
  if (status !== 200) {
    throw new TransientError(`GLS group tracking answered HTTP ${status}.`);
  }
  return body;
}

/** The service HTML-escapes its texts. */
function unescape(value: string | null): string | null {
  return value === null ? null : unescapeHtml(value);
}

function history(raw: Json, timeZone: string): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of asList(raw["history"])) {
    const event = asObject(entry);
    const at = localTime(event["date"], event["time"], timeZone);
    const rawStatus = unescape(text(event["evtDscr"])) ?? text(event["evtNo"]);
    if (at === null || rawStatus === null) {
      continue;
    }
    const code = text(event["evtNo"]);
    const location = text(asObject(event["address"])["city"]);
    events.push({ at, rawStatus, status: mapGls(code)?.status ?? null, location });
  }
  return latestHistory(events);
}

function weightKg(raw: Json): number | null {
  for (const entry of asList(raw["infos"])) {
    const info = asObject(entry);
    const value = text(info["value"]);
    const match =
      info["type"] === "WEIGHT" && value !== null ? /^(\d+(?:[.,]\d+)?)\s*kg$/i.exec(value) : null;
    if (match?.[1] !== undefined) {
      return Number(match[1].replace(",", "."));
    }
  }
  return null;
}

/** Turns one group tracking result into a snapshot; `report` receives unmapped codes. */
export function groupSnapshot(
  raw: Json,
  barcode: string,
  country: GroupCountry,
  report: (code: string) => void,
): ParcelSnapshot {
  const progress = asObject(raw["progressBar"]);
  const code = text(progress["statusInfo"]);
  const mapped = mapGls(code);
  if (code !== null && mapped === null) {
    report(code);
  }
  const returning = progress["retourFlag"] === true;
  const status = returning ? "returning" : (mapped?.status ?? null);
  const events = history(raw, country.timeZone);
  const newest = asObject(asList(raw["history"])[0]);
  // Exact codes only: DELIVEREDPS means the parcel waits in a ParcelShop.
  const delivered = code === "DELIVERED" && !returning;
  return snapshot({
    carrier: CARRIER_ID,
    // The service's own numbers are not always the code on the label; keep the one asked for.
    barcode,
    status,
    rawStatus: unescape(text(newest["evtDscr"]) ?? text(progress["statusText"])) ?? code,
    delivered,
    deliveredAt: delivered ? localTime(newest["date"], newest["time"], country.timeZone) : null,
    pickup: mapped?.pickup === true,
    url: publicUrl(barcode),
    weightKg: weightKg(raw),
    history: events,
    raw,
  });
}
