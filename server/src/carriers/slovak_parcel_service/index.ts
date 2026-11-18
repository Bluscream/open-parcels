import { z } from "zod";
import {
  carrierPattern,
  asObject,
  carrierKey,
  defineCarrier,
  isObject,
  readJson,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID, shipmentSnapshot } from "./parse.js";

const HOST = "rest.mysps.sk";
const CODE_PATTERN = carrierPattern("slovak_parcel_service");
/**
 * The fixed transport key the public MySPS website sends from every visitor's browser. It is not
 * a user credential (it is in the shared rules); when SPS rotates it, lookups fail with 401.
 */
const webKey = (): string => carrierKey(CARRIER_ID, "web_key");

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/** Returns the shipment, or null when SPS reports no result for the code. */
async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(
    new URL(`https://${HOST}/tracking/getShipmentTrackAndTrace`),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": webKey(),
      },
      body: JSON.stringify({ shipmentNr: code }),
    },
  );
  if (response.status === 401) {
    throw new UnexpectedResponseError(
      "SPS refused the website transport key; it may have changed.",
    );
  }
  if (response.status !== 200) {
    throw new TransientError(`SPS answered HTTP ${response.status}.`);
  }
  const body = asObject(readJson(response, "SPS"));
  const data = body["data"];
  if (isObject(data) && typeof data["shipmentNr"] === "string") {
    return data;
  }
  if (body["code"] === 401) {
    throw new UnexpectedResponseError(
      "SPS refused the website transport key; it may have changed.",
    );
  }
  if (body["status"] === false || data === null || data === undefined) {
    return null;
  }
  throw new UnexpectedResponseError("SPS answered with an unexpected envelope.");
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  return trackEach(barcodes, CODE_PATTERN, async (barcode) => {
    const raw = await lookUp(context.http, barcode);
    return raw === null ? null : shipmentSnapshot(raw, report);
  });
}

export const slovakParcelService = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Slovak Parcel Service",
  countries: ["SK"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 6_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
