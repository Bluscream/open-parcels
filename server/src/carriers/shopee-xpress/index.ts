import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type HostLimit,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import {
  asObject,
  CARRIER_ID,
  MARKET_IDS,
  MARKETS,
  orderSnapshot,
  type Json,
  type Market,
} from "./parse.js";

const CODE_PATTERN = /^[A-Z0-9]{8,30}$/i;

const configSchema = z.looseObject({
  /** The market the parcels were sent in; a code only resolves on its own market's host. */
  market: z.enum(MARKET_IDS),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/**
 * Returns the `data` block, or null when SPX answers with its error envelope. That envelope
 * looks the same for an unknown code and a broken backend, so null means "no answer", not
 * "does not exist".
 */
async function lookUp(http: PluginHttp, code: string, market: Market): Promise<Json | null> {
  const { host, language } = MARKETS[market];
  const url = new URL(`https://${host}/shipment/order/open/order/get_order_info`);
  url.searchParams.set("spx_tn", code);
  url.searchParams.set("language_code", language);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`Shopee Xpress answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("Shopee Xpress did not answer with JSON.");
  }
  const body = asObject(payload);
  if (typeof body["retcode"] !== "number") {
    throw new UnexpectedResponseError("Shopee Xpress answered without a result code.");
  }
  if (body["retcode"] !== 0) {
    return null;
  }
  const data = body["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new UnexpectedResponseError("Shopee Xpress answered success without data.");
  }
  return data as Json;
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const market = context.config.market;
  const snapshots: ParcelSnapshot[] = [];
  let complete = true;
  const report = (code: string): void => {
    context.reportUnknown("milestone_code", code);
  };
  for (const barcode of barcodes) {
    if (!CODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode, market);
    if (raw === null) {
      complete = false;
      continue;
    }
    snapshots.push(orderSnapshot(raw, barcode, market, report));
  }
  return { snapshots, complete };
}

const PUBLIC: HostLimit = { intervalMs: 6_000, burst: 2 };

export const shopeeXpress = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Shopee Xpress",
  countries: ["BR", "ID", "MY", "PH", "TH", "VN"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      ...Object.fromEntries(MARKET_IDS.map((id) => [MARKETS[id].host, PUBLIC])),
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
