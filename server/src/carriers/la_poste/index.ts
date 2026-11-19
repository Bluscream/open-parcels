import { z } from "zod";
import {
  carrierPattern,
  carrierKey,
  defineCarrier,
  expectStatus,
  isObject,
  readJson,
  trackEach,
  TransientError,
  unknownReporter,
  UnexpectedResponseError,
  type Json,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";
import { CARRIER_ID, toSnapshot } from "./parse.js";

const API_HOST = "www.laposte.fr";
const BARCODE_PATTERN = carrierPattern("la_poste");

/** `returnCode`s that say the shipment is unknown or not scanned yet. */
const NOT_FOUND: ReadonlySet<number> = new Set([104, 105, 404]);

/**
 * One keyless endpoint serves La Poste, Colissimo and Chronopost. It answers a one-element list
 * whose `returnCode` is 200 for a known shipment and one of `NOT_FOUND` for an unknown one; any
 * other code (a server error in the body, say) is a transient failure, never "not found".
 */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const url = new URL(
    `https://${API_HOST}/ssu/sun/back/suivi-unifie/${encodeURIComponent(barcode)}`,
  );
  url.searchParams.set("lang", "fr");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  expectStatus(response, "La Poste", 200);
  const payload = readJson(response, "La Poste");
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
  const returnCode = envelope["returnCode"];
  if (typeof returnCode === "number" && NOT_FOUND.has(returnCode)) {
    return null;
  }
  if (returnCode !== 200) {
    // A server error carried in the body, or a code not known to mean "unknown shipment".
    throw new TransientError(`La Poste answered return code ${String(returnCode)}.`);
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
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, BARCODE_PATTERN, async (barcode) => {
    const raw = await lookUp(context.http, barcode);
    // The registered code stays the barcode, even when Chronopost names a canonical id.
    return raw === null ? null : toSnapshot(raw, barcode, report);
  });
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
      value: carrierKey(CARRIER_ID, "user_agent"),
      reason: "The tracking endpoint turns away unrecognised client User-Agents.",
    },
  },
  track,
});
