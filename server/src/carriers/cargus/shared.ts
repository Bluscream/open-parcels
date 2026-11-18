import { createCipheriv, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  asArray as asList,
  carrierKey,
  isObject,
  isoTime,
  newestFirst,
  parseJsonBody,
  ruleTextStatus,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  text,
  type HttpResponse,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "cargus";
export const API_HOST = "cmacwabackend.azurewebsites.net";
export const API_BASE = `https://${API_HOST}/api`;
export const PORTAL = "https://mycargus.cargus.ro";
const ZONE = "Europe/Bucharest";
const HISTORY_LIMIT = 20;
const MAX_BYTES = 1024 * 1024;

/**
 * The app's `k`/`seed`/`s` headers: `message` AES-128-CBC encrypted (PKCS#7) under the app's
 * fixed header key (in the shared rules) with a fresh random IV, which travels as `seed`. The
 * anonymous tracking sends a random message; the signed-in app sends the account's phone number.
 */
export function appHeaders(message: string): { k: string; seed: string; s: string } {
  const key = Buffer.from(carrierKey(CARRIER_ID, "header_key"), "hex");
  const iv = randomBytes(16);
  const cipher = createCipheriv(`aes-${String(key.length * 8)}-cbc`, key, iv);
  const sealed = Buffer.concat([cipher.update(message, "utf8"), cipher.final()]);
  return { k: sealed.toString("base64"), seed: iv.toString("hex"), s: "M" };
}

/** A fresh 12-character message for one anonymous request. */
export const anonymousMessage = (): string => randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * The web portal's `K` header: the account's phone number interleaved with random noise, the
 * way the portal's own script builds it.
 */
export function portalPhoneKey(phone: string): string {
  const plus = phone.startsWith("+");
  const digits = phone.replace(/^\+/, "").padEnd(7, "0");
  const [k0 = "0", k1 = "0", k2 = "0", k3 = "0"] = String(randomInt(0, 1000) * 9 + 1750)
    .slice(0, 4)
    .split("");
  const noise = randomUUID().replaceAll("-", "").repeat(2);
  const secret =
    `${digits.slice(0, 1)}${k0}${digits.slice(1, 3)}${k1}${digits.slice(3, 5)}${k2}${digits.slice(5, 7)}${k3}${digits.slice(7)}`
      .padEnd(20, "X")
      .concat(plus ? "Y" : "X");
  // The secret is ASCII (digits, X, Y), so splitting by code unit is exact.
  let mixed = secret
    .split("")
    .map((char, index) => noise.slice(index * 2, index * 2 + 2) + char)
    .join("");
  mixed = `${mixed.slice(0, 6)}${k2}${mixed.slice(6, 8)}${k3}${mixed.slice(8)}`;
  const at = Number(k1);
  return `${mixed.slice(0, at)}${k0}${mixed.slice(at)}${k1}`;
}

/**
 * A 200 body as JSON; an empty body (or 204) is null. HTML or anything not JSON is an unexpected
 * answer that stops the run.
 */
export function readBody(response: HttpResponse, what: string): unknown {
  const body = response.body.replace(/^\uFEFF/, "").trim();
  if (response.status === 204 || body === "") {
    return null;
  }
  if (body.startsWith("<")) {
    throw new UnexpectedResponseError(`${what} answered with a web page.`);
  }
  const parsed = parseJsonBody(body);
  if (parsed === null) {
    throw new UnexpectedResponseError(`${what} did not answer with JSON.`);
  }
  return parsed;
}

/**
 * The anonymous short trace of one AWB. An empty answer means Cargus has nothing (unknown, not
 * yet scanned or expired). A refusal is the same for every number and stops the run.
 */
export async function shortTrace(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`${API_BASE}/Awbs/ShortTrace`);
  url.searchParams.set("BarCode", code);
  url.searchParams.set("lang", "EN");
  const response = await http.request(url, {
    headers: { accept: "application/json", ...appHeaders(anonymousMessage()) },
    maxBytes: MAX_BYTES,
  });
  if (response.status !== 200 && response.status !== 204) {
    throw new TransientError(`Cargus tracking answered HTTP ${response.status}.`);
  }
  const payload = readBody(response, "Cargus tracking");
  if (payload === null) {
    return null;
  }
  if (!isObject(payload) || text(payload["awbBarcode"]) !== code) {
    throw new UnexpectedResponseError("Cargus answered about another parcel.");
  }
  return payload;
}

/** Wordings carry no code; the shared table matches the English wording (lang=EN). */
const wordingStatus = (value: string | null): SnapshotEvent["status"] =>
  value === null ? null : ruleTextStatus(CARRIER_ID, value.replace(/\s+/g, " ").trim());

function events(trace: Json): SnapshotEvent[] {
  const seen = new Set<string>();
  const result: SnapshotEvent[] = [];
  for (const event of asList(trace["events"]).filter(isObject)) {
    const at = isoTime(event["date"], { naive: { zone: ZONE } });
    const rawStatus = text(event["event"]);
    const key = JSON.stringify([
      event["date"],
      event["event"],
      event["countyName"],
      event["localityName"],
    ]);
    if (at === null || rawStatus === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      at,
      rawStatus,
      status: wordingStatus(rawStatus),
      location: text(event["localityName"]),
    });
  }
  return newestFirst(result);
}

export function publicUrl(code: string): string {
  return `https://www.cargus.ro/personal/urmareste-coletul/?tracking_number=${encodeURIComponent(code)}`;
}

/**
 * The newest mappable scan decides. When a newer scan has a wording the table does not know, a
 * summary of "Delivered" still wins, so a delivered parcel never stays out for delivery.
 */
export function traceSnapshot(
  trace: Json,
  report: (key: string) => void,
  extra: Partial<Parameters<typeof snapshot>[0]> = {},
): ParcelSnapshot {
  const history = events(trace);
  const summary = text(trace["statusMessage"]);
  const summaryStatus = wordingStatus(summary);
  const firstMapped = history.findIndex((event) => event.status !== null);
  for (const event of history.slice(0, firstMapped === -1 ? history.length : firstMapped)) {
    report(event.rawStatus);
  }
  let status = firstMapped === -1 ? summaryStatus : (history[firstMapped]?.status ?? null);
  if (firstMapped > 0 && summaryStatus === "delivered") {
    status = "delivered";
  }
  if (history.length === 0 && summary !== null && summaryStatus === null) {
    report(summary);
  }
  const delivered = status === "delivered";
  const code = text(trace["awbBarcode"]) ?? "";
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: history[0]?.rawStatus ?? summary,
    delivered,
    deliveredAt: delivered
      ? (history.find((event) => event.status === "delivered")?.at ?? history[0]?.at ?? null)
      : null,
    url: publicUrl(code),
    history: history.slice(0, HISTORY_LIMIT),
    raw: trace,
    ...extra,
  });
}
