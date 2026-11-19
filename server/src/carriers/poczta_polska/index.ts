import { z } from "zod";
import {
  carrierPattern,
  asObject,
  defineCarrier,
  isObject,
  isoTime,
  objects,
  positive,
  readObject,
  rulesTrackingUrl,
  snapshot,
  text as kitText,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
  echoRef,
} from "../../plugin/api.js";
import { codeStatus } from "./status.js";

export const CARRIER_ID = "poczta_polska";
const ZONE = "Europe/Warsaw";
const PORTAL = new URL("https://emonitoring.poczta-polska.pl/");
export const API_HOST = "uss.poczta-polska.pl";
/** The only endpoint the widget key is ever sent to; the portal must advertise exactly this. */
const API_BASE = `https://${API_HOST}/uss/v2.0/tracking`;
const BARCODE = carrierPattern("poczta_polska");

/** Poczta Polska's fields are strings; a number in one is not taken as text. */
const text = (value: unknown): string | null => kitText(value, { numbers: false });

const configSchema = z.object({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

/**
 * The public portal page carries the key its own tracking widget uses, on the element with id
 * `widgetTracking`. It is read from there, never stored in the code.
 */
async function readKey(http: PluginHttp): Promise<string> {
  const response = await http.request(PORTAL, { redirect: "manual" });
  if (response.status !== 200) {
    throw new TransientError(`Poczta Polska portal answered HTTP ${response.status}.`);
  }
  const tag = /<[^>]*\bid=["']widgetTracking["'][^>]*>/i.exec(response.body)?.[0] ?? "";
  const attribute = (name: string): string =>
    new RegExp(`\\b${name}=["']([^"']*)["']`, "i").exec(tag)?.[1]?.trim() ?? "";
  const base = attribute("data-urltracking");
  const key = attribute("data-apikey");
  if (base === "" || key === "") {
    throw new UnexpectedResponseError("Poczta Polska portal no longer shows the tracking widget.");
  }
  if (base !== API_BASE) {
    throw new UnexpectedResponseError("Poczta Polska portal advertises an unexpected endpoint.");
  }
  return key;
}

/** Returns the payload, or null when the key was refused (HTTP 401). */
async function post(http: PluginHttp, barcode: string, key: string): Promise<Json | null> {
  const response = await http.request(new URL(`${API_BASE}/checkmailex`), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", accept: "application/json", API_KEY: key },
    body: JSON.stringify({ language: "EN", number: barcode, addPostOfficeInfo: false }),
  });
  if (response.status === 401) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Poczta Polska tracking answered HTTP ${response.status}.`);
  }
  return readObject(response, "Poczta Polska tracking");
}

const usable = (mail: Json): Json[] =>
  objects(mail["events"]).filter((event) => event["canceled"] !== true);

/** A record with parcel details and at least one live scan; null for unknown or grouped ones. */
function found(payload: Json): Json | null {
  const mail = payload["mailInfo"];
  if (!isObject(mail)) {
    if (payload["mailStatus"] !== -1) {
      throw new UnexpectedResponseError("Poczta Polska answered without parcel details.");
    }
    return null;
  }
  const grouped = Array.isArray(mail["components"]) && mail["components"].length > 0;
  return grouped || usable(mail).length === 0 ? null : payload;
}

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const mail = asObject(raw["mailInfo"]);
  const timed = usable(mail)
    .map((event) => ({
      event,
      at: isoTime(event["time"], { naive: { zone: ZONE } }),
    }))
    .filter((entry): entry is { event: Json; at: string } => entry.at !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const history: SnapshotEvent[] = [];
  for (const { event, at } of timed) {
    const code = text(event["code"]);
    const rawStatus = text(event["name"]) ?? code;
    if (rawStatus !== null) {
      history.push({ at, status: codeStatus(code), rawStatus, location: null });
    }
  }
  const latest = history[0];
  const latestEvent = timed[0]?.event;
  const code = text(latestEvent?.["code"]);
  const status = codeStatus(code);
  if (code !== null && status === null) {
    report(code);
  }
  // A closed return is finished but never reached the recipient.
  const delivered = status === "delivered" || (mail["finished"] === true && status !== "returning");
  const office = asObject(latestEvent?.["postOffice"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    externalRef: echoRef(text(raw["number"]), barcode),
    status,
    rawStatus: latest?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered ? (latest?.at ?? null) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? text(office["name"]) : null,
    url: rulesTrackingUrl(CARRIER_ID, barcode, "pl"),
    weightKg: positive(mail["weight"]),
    history,
    raw,
  });
}

interface KeyHolder {
  key: string | null;
}

/** Looks one code up, re-reading the widget key once when the endpoint refuses it. */
async function lookUp(http: PluginHttp, holder: KeyHolder, barcode: string): Promise<Json | null> {
  holder.key ??= await readKey(http);
  let payload = await post(http, barcode, holder.key);
  if (payload === null) {
    holder.key = await readKey(http);
    payload = await post(http, barcode, holder.key);
    if (payload === null) {
      throw new TransientError("Poczta Polska refused the widget key twice.");
    }
  }
  return found(payload);
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const holder: KeyHolder = { key: null };
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, holder, barcode);
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

/** Poczta Polska: the public tracking behind the e-monitoring portal. */
export const pocztaPolska = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Poczta Polska",
  countries: ["PL"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [PORTAL.hostname]: { intervalMs: 30_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
