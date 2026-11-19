import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  expectStatus,
  isObject,
  objects,
  readObject,
  text,
  trackEach,
  unknownReporter,
  UnexpectedResponseError,
  type Json,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID, toSnapshot, WALL_CLOCK_ZONE } from "./parse.js";

const API_HOST = "www.gofo.com";
/** Two keyless transports, chosen by the country letters after the `GF` prefix. */
const TRANSPORT_A = new Set(["US", "CA"]);
const TRANSPORT_B_LANG: Readonly<Record<string, string>> = {
  IT: "it",
  FR: "fr",
  ES: "es",
  NL: "nl",
};
const BARCODE_PATTERN = carrierPattern("gofo");

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
  expectStatus(response, "GOFO", 200);
  return readObject(response, "GOFO");
}

function pick(items: unknown, barcode: string): Json | null {
  return objects(items).find((item) => text(item["waybillNo"]) === barcode) ?? null;
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
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, BARCODE_PATTERN, async (barcode) => {
    const country = countryOf(barcode) ?? "";
    const wallClock = TRANSPORT_A.has(country);
    let raw: Json | null = null;
    if (wallClock) {
      raw = await transportA(context.http, barcode, country);
    } else if (TRANSPORT_B_LANG[country] !== undefined) {
      raw = await transportB(context.http, barcode, country);
    }
    return raw === null ? null : toSnapshot(raw, barcode, { wallClock, report });
  });
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
