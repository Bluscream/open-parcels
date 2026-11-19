import { z } from "zod";
import {
  carrierKey,
  carrierPattern,
  asArray,
  asObject,
  defineCarrier,
  isObject,
  newestFirst,
  num,
  parseLocal,
  requestJson,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  UnexpectedResponseError,
  unknownReporter,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "correos";
const HOST = "localizador.correos.es";
const ZONE = "Europe/Madrid";
const PLAUSIBLE = carrierPattern("correos");

/**
 * The endpoint answers a one-element list (sometimes a bare object). Every real answer carries
 * an error block; a non-zero code means "no traceability", the normal not-found.
 */
async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(
    `https://${HOST}/canonico/eventos_envio_servicio/${encodeURIComponent(code)}`,
  );
  for (const [key, value] of Object.entries({
    codAplicacion: carrierKey(CARRIER_ID, "application_code"),
    codCanal: carrierKey(CARRIER_ID, "channel_code"),
    codIdioma: "ES",
    indUltEvento: "N",
  })) {
    url.searchParams.set(key, value);
  }
  const body = await requestJson(http, url, "Correos tracking");
  const envelope: unknown = Array.isArray(body) ? body[0] : body;
  const error = asObject(asObject(envelope)["error"]);
  if (!isObject(envelope) || error["codError"] === undefined || error["codError"] === null) {
    throw new UnexpectedResponseError("Correos answered without a shipment envelope.");
  }
  const errorCode = text(error["codError"]);
  if (errorCode === "0") {
    return envelope;
  }
  // "No traceability" is the normal not-found; any other error is a failure, never a code that
  // silently reads as not found.
  if (errorCode !== null && NOT_FOUND_CODES.has(errorCode)) {
    return null;
  }
  throw new UnexpectedResponseError("Correos answered with an error it does not explain.");
}

/** Correos's `codError` for a shipment it has no traceability for. */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["1"]);

/** `fecEvento` (DD/MM/YYYY) and `horEvento` (HH:MM:SS), in Spanish local time. */
function eventTime(event: Json): string | null {
  const date = text(event["fecEvento"]);
  return date === null
    ? null
    : parseLocal(`${date} ${text(event["horEvento"]) ?? "00:00:00"}`, ZONE, "DMY");
}

function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  // Events run oldest to newest.
  const events = asArray(raw["eventos"]).filter(isObject);
  const latest = events.at(-1);
  const latestCode = latest === undefined ? null : text(latest["codEvento"]);
  const status = ruleStatus(CARRIER_ID, latestCode, report);
  const delivered = status === "delivered";
  const history: SnapshotEvent[] = events.flatMap((event) => {
    const at = eventTime(event);
    const eventCode = text(event["codEvento"]);
    const rawStatus = text(event["desTextoResumen"]) ?? eventCode;
    return at === null || rawStatus === null
      ? []
      : [{ at, rawStatus, status: ruleStatus(CARRIER_ID, eventCode), location: null }];
  });
  const grams = num(raw["peso"], { decimalComma: true });
  const barcode = text(raw["codEnvio"]) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest === undefined ? null : (text(latest["desTextoResumen"]) ?? latestCode),
    delivered,
    deliveredAt: delivered && latest !== undefined ? eventTime(latest) : null,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? text(raw["nom_codired"]) : null,
    url: `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(barcode)}`,
    weightKg: grams === null || grams <= 0 ? null : grams / 1000,
    history: newestFirst(history),
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code", { once: false });
  return trackEach(barcodes, PLAUSIBLE, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, code, report);
  });
}

export const correos = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Correos",
  countries: ["ES"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
