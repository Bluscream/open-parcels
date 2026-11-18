import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { asObject, CARRIER_ID, shipmentSnapshot, type Json } from "./parse.js";

const HOST = "rest.mysps.sk";
const CODE_PATTERN = /^[A-Z0-9]{6,30}$/i;
/**
 * The fixed transport key the public MySPS website sends from every visitor's browser. It is not
 * a user credential; when SPS rotates it, lookups fail with 401 and this needs updating.
 */
const WEB_KEY = "6VS314WZ+YtFPrYqqV2EZAoxKJNIyr13JGKTWjlOy6jz5zWKr-C8ZnpCJ7ChvZfW";

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
        "api-key": WEB_KEY,
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
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("SPS did not answer with JSON.");
  }
  const body = asObject(payload);
  const data = body["data"];
  if (
    typeof data === "object" &&
    data !== null &&
    typeof asObject(data)["shipmentNr"] === "string"
  ) {
    return data as Json;
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
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  for (const barcode of barcodes) {
    if (!CODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(shipmentSnapshot(raw, report));
    }
  }
  return { snapshots, complete: true };
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
