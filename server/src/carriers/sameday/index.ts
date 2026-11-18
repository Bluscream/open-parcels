import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { asObject, awbSnapshot, CARRIER_ID, COUNTRIES, type Country, type Json } from "./parse.js";

/** AWB numbers are digits, sometimes with a letter prefix; anything else is never sent. */
const AWB_PATTERN = /^[A-Z0-9]{6,30}$/i;

const configSchema = z.looseObject({
  /** Which national host to ask: Romania, Hungary or Bulgaria. Default Romania. */
  country: z.enum(COUNTRIES).optional(),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/** Returns the AWB history, or null when Sameday does not know the code (404 or no history). */
async function lookUp(http: PluginHttp, barcode: string, country: Country): Promise<Json | null> {
  const url = new URL(
    `https://api.sameday.${country}/api/public/awb/${encodeURIComponent(barcode)}/awb-history`,
  );
  url.searchParams.set("_locale", country);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Sameday answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Sameday did not answer with JSON.");
  }
  const body = asObject(payload);
  if (!Array.isArray(body["awbHistory"])) {
    throw new UnexpectedResponseError("Sameday answered without an AWB history.");
  }
  return body["awbHistory"].length === 0 ? null : body;
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const country = context.config.country ?? "ro";
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!AWB_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode, country);
    if (raw !== null) {
      snapshots.push(awbSnapshot(raw, barcode, country, report));
    }
  }
  return { snapshots, complete: true };
}

export const sameday = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Sameday",
  countries: ["RO", "HU", "BG"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      "api.sameday.ro": { intervalMs: 5_000, burst: 2 },
      "api.sameday.hu": { intervalMs: 5_000, burst: 2 },
      "api.sameday.bg": { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
