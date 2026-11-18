import { z } from "zod";
import {
  carrierPattern,
  asArray,
  carrierKey,
  defineCarrier,
  isObject,
  readObject,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";

import { CARRIER_ID, shipmentSnapshot } from "./parcel.js";

const HOST = "api2.postnord.com";
const API = `https://${HOST}/rest/shipment/v5/trackandtrace/recipientview`;

const BARCODE = carrierPattern("postnord");

const configSchema = z.object({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (status: string): void => {
    context.reportUnknown("status_code", status);
  };
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const url = new URL(API);
    url.search = new URLSearchParams({ id: barcode, locale: "en" }).toString();
    const response = await context.http.request(url, {
      headers: {
        accept: "application/json",
        // The tag PostNord's own tracking website sends; a public client name, not a secret.
        "x-bap-key": carrierKey(CARRIER_ID, "web_client"),
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new TransientError(`PostNord refused its web client tag (HTTP ${response.status}).`);
    }
    if (response.status !== 200) {
      throw new TransientError(`PostNord tracking answered HTTP ${response.status}.`);
    }
    const envelope = readObject(response, "PostNord tracking")["TrackingInformationResponse"];
    if (!isObject(envelope)) {
      throw new UnexpectedResponseError("PostNord answered without its tracking envelope.");
    }
    const first: unknown = asArray(envelope["shipments"])[0];
    if (first === undefined) {
      continue;
    }
    if (!isObject(first)) {
      throw new UnexpectedResponseError("PostNord listed something that is not a shipment.");
    }
    snapshots.push(shipmentSnapshot(first, barcode, report));
  }
  return { snapshots, complete: true };
}

/** PostNord (Denmark, Sweden, Norway, Finland): the public recipient view. */
export const postnord = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "PostNord",
  countries: ["DK", "SE", "NO", "FI"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 4_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
