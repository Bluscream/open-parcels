import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { CARRIER_ID, isObject, text, toSnapshot, WALL_CLOCK_ZONE, type Json } from "./parse.js";

const API_HOST = "www.gofo.com";
/** Two keyless transports, chosen by the country letters after the `GF` prefix. */
const TRANSPORT_A = new Set(["US", "CA"]);
const TRANSPORT_B_LANG: Readonly<Record<string, string>> = {
  IT: "it",
  FR: "fr",
  ES: "es",
  NL: "nl",
};
const BARCODE_PATTERN = /^GF([A-Z]{2})[A-Z0-9]{4,40}$/;

export function countryOf(barcode: string): string | null {
  return BARCODE_PATTERN.exec(barcode)?.[1] ?? null;
}

async function post(
  http: PluginHttp,
  path: string,
  barcode: string,
  headers: Record<string, string>,
) {
  const response = await http.request(new URL(`https://${API_HOST}${path}`), {
    method: "POST",
    body: JSON.stringify({ numberList: [barcode] }),
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
  });
  if (response.status !== 200) {
    throw new TransientError(`GOFO answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("GOFO did not answer with JSON.");
  }
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("GOFO did not answer with an object.");
  }
  return payload;
}

function pick(items: unknown, barcode: string): Json | null {
  if (!Array.isArray(items)) {
    return null;
  }
  return items.filter(isObject).find((item) => text(item["waybillNo"]) === barcode) ?? null;
}

/** US and CA. A failure envelope with an `error` block means not found. */
async function transportA(http: PluginHttp, barcode: string, country: string) {
  const payload = await post(
    http,
    `/${country.toLowerCase()}/cnee-api/consignee/track/query`,
    barcode,
    {
      "user-time-zone": WALL_CLOCK_ZONE,
    },
  );
  const data = isObject(payload["data"]) ? payload["data"] : {};
  if (payload["success"] !== true && payload["success"] !== 1) {
    if (data["error"] !== undefined && data["error"] !== null) {
      return null;
    }
    throw new UnexpectedResponseError("GOFO answered with an unknown failure envelope.");
  }
  return pick(data["success"], barcode);
}

/** IT, FR, ES and NL. An empty list means not found. */
async function transportB(http: PluginHttp, barcode: string, country: string) {
  const payload = await post(
    http,
    `/${country.toLowerCase()}/open-api/official/track/queryTrackV2`,
    barcode,
    {
      lang: TRANSPORT_B_LANG[country] ?? "en",
    },
  );
  if (payload["code"] !== 200) {
    throw new UnexpectedResponseError("GOFO answered with a failure code.");
  }
  return pick(payload["data"], barcode);
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
    const country = countryOf(barcode);
    if (country === null) {
      continue;
    }
    const wallClock = TRANSPORT_A.has(country);
    let raw: Json | null = null;
    if (wallClock) {
      raw = await transportA(context.http, barcode, country);
    } else if (TRANSPORT_B_LANG[country] !== undefined) {
      raw = await transportB(context.http, barcode, country);
    }
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, country, { wallClock, report }));
    }
  }
  return { snapshots, complete: true };
}

export const gofo = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "GOFO Express",
  countries: ["US", "CA", "IT", "FR", "ES", "NL"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
