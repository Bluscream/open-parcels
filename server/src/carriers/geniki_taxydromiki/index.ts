import { z } from "zod";
import {
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { localIso, mapCode, type Checkpoint, CONTROL_CODES, decidingCode } from "./status.js";

const CARRIER_ID = "geniki_taxydromiki";
const API_HOST = "taxydromiki.com";
const API_URL = `https://${API_HOST}/external_scripts/track-site.php`;
/** A found code can take over half a minute to answer; an unknown one answers at once. */
const TIMEOUT_MS = 60_000;
const RESULT_FOUND = 0;
const RESULT_NOT_FOUND = 9;
const BARCODE_PATTERN = /^[A-Z0-9]{6,30}$/i;

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Posts one code. Null when the carrier does not know it or has no scans for it yet. */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  // The endpoint wants a bare JSON string as the body, sent with a form content type.
  const response = await http.request(new URL(API_URL), {
    method: "POST",
    body: JSON.stringify({ lang: "en", voucherNo: barcode }),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    timeoutMs: TIMEOUT_MS,
  });
  if (response.status !== 200) {
    throw new TransientError(`Geniki Taxydromiki answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Geniki Taxydromiki did not answer with JSON.");
  }
  if (!isObject(payload) || payload["success"] !== true) {
    throw new UnexpectedResponseError("Geniki Taxydromiki answered with an unexpected envelope.");
  }
  const entry = payload[barcode];
  const result = isObject(entry) ? entry["TrackAndTraceResult"] : undefined;
  if (!isObject(result)) {
    throw new UnexpectedResponseError("Geniki Taxydromiki reply lacks the requested code.");
  }
  if (result["Result"] === RESULT_NOT_FOUND) {
    return null;
  }
  if (result["Result"] !== RESULT_FOUND) {
    throw new UnexpectedResponseError("Geniki Taxydromiki returned an unexpected Result.");
  }
  return checkpoints(result).length === 0 ? null : result;
}

/** Checkpoints oldest first; a single object is accepted as a list of one. */
function checkpoints(result: Json): Checkpoint[] {
  const container = result["Checkpoints"];
  const items: unknown = isObject(container) ? container["Checkpoint"] : undefined;
  const list: unknown[] = Array.isArray(items) ? items : isObject(items) ? [items] : [];
  const parsed: Checkpoint[] = [];
  for (const item of list) {
    if (!isObject(item)) {
      continue;
    }
    parsed.push({
      code: text(item["StatusCode"]),
      label: text(item["Status"]),
      at: localIso(item["StatusDate"]),
      location: text(item["Shop"]),
    });
  }
  // Undated checkpoints sort first so they never override a dated one.
  return parsed.sort(
    (a, b) =>
      (a.at === null ? -Infinity : Date.parse(a.at)) -
      (b.at === null ? -Infinity : Date.parse(b.at)),
  );
}

function toSnapshot(raw: Json, barcode: string, report: (code: string) => void): ParcelSnapshot {
  const scans = checkpoints(raw);
  for (const scan of scans) {
    if (scan.code !== null && mapCode(scan.code) === null && !CONTROL_CODES.has(scan.code)) {
      report(scan.code);
    }
  }
  const status = mapCode(decidingCode(scans));
  const delivered = status === "delivered";
  const latest = scans.at(-1);
  let deliveredAt: string | null = null;
  if (delivered) {
    const scan = [...scans].reverse().find((s) => mapCode(s.code) === "delivered" && s.at !== null);
    deliveredAt =
      (raw["Status"] === "DELIVERED" ? localIso(raw["DeliveryDate"]) : null) ?? scan?.at ?? null;
  }
  const history: SnapshotEvent[] = [];
  for (const scan of [...scans].reverse()) {
    const rawStatus = scan.label ?? scan.code;
    if (scan.at !== null && rawStatus !== null) {
      history.push({ at: scan.at, rawStatus, status: mapCode(scan.code), location: scan.location });
    }
  }
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest?.label ?? latest?.code ?? text(raw["Status"]),
    delivered,
    deliveredAt,
    receiver: delivered ? text(raw["Consignee"]) : null,
    url: `https://taxydromiki.com/track/${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const genikiTaxydromiki = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Geniki Taxydromiki",
  countries: ["GR", "CY"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 6_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
