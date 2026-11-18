import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { CARRIER_ID, isObject, toSnapshot, type Json } from "./parse.js";

const API_HOST = "www.laposte.fr";
const BARCODE_PATTERN = /^[A-Z0-9]{8,30}$/i;

/**
 * One keyless endpoint serves La Poste, Colissimo and Chronopost. It answers a one-element list
 * whose `returnCode` is 200 for a known shipment; any other code means unknown or not scanned.
 */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${API_HOST}/ssu/sun/back/suivi-unifie/${encodeURIComponent(barcode)}`,
  );
  url.searchParams.set("lang", "fr");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`La Poste answered HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = response.json();
  } catch {
    throw new UnexpectedResponseError("La Poste did not answer with JSON.");
  }
  if (!Array.isArray(payload)) {
    throw new UnexpectedResponseError("La Poste did not answer with a list.");
  }
  if (payload.length === 0) {
    return null;
  }
  const envelope: unknown = payload[0];
  if (payload.length !== 1 || !isObject(envelope)) {
    throw new UnexpectedResponseError("La Poste answered with an unexpected list.");
  }
  if (envelope["returnCode"] !== 200) {
    return null;
  }
  const shipment = envelope["shipment"];
  if (!isObject(shipment)) {
    throw new UnexpectedResponseError("La Poste reported success without a shipment.");
  }
  return shipment;
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
      // The registered code stays the barcode, even when Chronopost names a canonical id.
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const laposte = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "La Poste (Colissimo, Chronopost)",
  countries: ["FR"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 6_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: {
      value: "PostmanRuntime/7.49.1",
      reason: "The tracking endpoint turns away unrecognised client User-Agents.",
    },
  },
  track,
});
