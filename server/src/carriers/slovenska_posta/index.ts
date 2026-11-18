import { z } from "zod";
import {
  asObject,
  defineCarrier,
  readJson,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID, resultSnapshot, STRINGS } from "./parse.js";

const HOST = "api.posta.sk";
/** The documented cap on codes per request. */
const BATCH_SIZE = 100;
const CODE_PATTERN = /^[A-Z0-9]{8,30}$/i;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/** Looks up to BATCH_SIZE codes up at once; returns the results by number. */
async function lookUpBatch(http: PluginHttp, codes: readonly string[]): Promise<Map<string, Json>> {
  const url = new URL(`https://${HOST}/tracking`);
  url.searchParams.set("q", codes.join(","));
  url.searchParams.set("l", "en");
  url.searchParams.set("p", "1");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`Slovenská pošta answered HTTP ${response.status}.`);
  }
  const results = asObject(readJson(response, "Slovenská pošta"))["results"];
  if (!Array.isArray(results)) {
    throw new UnexpectedResponseError("Slovenská pošta answered without a result list.");
  }
  const byNumber = new Map<string, Json>();
  for (const item of results) {
    const result = asObject(item);
    const number = text(result["number"], STRINGS);
    // A malformed code is a different signal from "not found"; it never becomes a parcel.
    if (number !== null && result["status"] !== "invalid_format") {
      byNumber.set(number.toUpperCase(), result);
    }
  }
  return byNumber;
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const codes = barcodes.filter((code) => CODE_PATTERN.test(code));
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (let start = 0; start < codes.length; start += BATCH_SIZE) {
    const chunk = codes.slice(start, start + BATCH_SIZE);
    const results = await lookUpBatch(context.http, chunk);
    for (const code of chunk) {
      const raw = results.get(code.toUpperCase());
      const events = raw?.["events"];
      // No result, or no events yet (or no longer kept): not found.
      if (raw !== undefined && Array.isArray(events) && events.length > 0) {
        snapshots.push(resultSnapshot(raw, code, report));
      }
    }
  }
  return { snapshots, complete: true };
}

export const slovenskaPosta = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Slovenská pošta",
  countries: ["SK"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 10_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
