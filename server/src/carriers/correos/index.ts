import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  asArray,
  asObject,
  isObject,
  mapLocal,
  newestFirst,
  num,
  requestJson,
  statusReporter,
  text,
  trackOneByOne,
  type Json,
  type ParcelStatus,
} from "../_kit/json.js";
import { parseLocal } from "../_kit/zoned.js";

const CARRIER_ID = "correos";
const HOST = "localizador.correos.es";
const ZONE = "Europe/Madrid";
const PLAUSIBLE = /^[A-Z0-9]{8,30}$/i;

/** Event codes (`codEvento`); the same codes appear on the latest event and in the history. */
const EVENT_STATUS: Readonly<Record<string, ParcelStatus>> = {
  A010000V: "registered",
  A090000V: "registered",
  X010000V: "registered",
  P040000V: "in_transit",
  G01L010V: "in_transit",
  P101110V: "in_transit",
  P101120V: "in_transit",
  P100000V: "in_transit",
  P090000V: "in_transit",
  P110000V: "in_transit",
  H01I360V: "in_transit",
  X020000V: "in_transit",
  X040000V: "in_transit",
  X060000V: "in_transit",
  X070000V: "in_transit",
  X110100V: "in_transit",
  H020000V: "out_for_delivery",
  X080000V: "out_for_delivery",
  L010000V: "at_pickup_point",
  H01I350V: "at_pickup_point",
  X380000V: "at_pickup_point",
  X390000V: "at_pickup_point",
  I010000V: "delivered",
  I01H210V: "delivered",
  X120000V: "delivered",
  H010930R: "problem",
  M01E020R: "problem",
  H06P010V: "problem",
  X090100R: "problem",
  X090060R: "problem",
  X130000R: "problem",
  O140000V: "returning",
};

/**
 * The endpoint answers a one-element list (sometimes a bare object). Every real answer carries
 * an error block; a non-zero code means "no traceability", the normal not-found.
 */
async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(
    `https://${HOST}/canonico/eventos_envio_servicio/${encodeURIComponent(code)}`,
  );
  for (const [key, value] of Object.entries({
    codAplicacion: "60",
    codCanal: "3",
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
  return text(error["codError"]) === "0" ? envelope : null;
}

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
  const status = mapLocal(EVENT_STATUS, latestCode, report);
  const delivered = status === "delivered";
  const history: SnapshotEvent[] = events.flatMap((event) => {
    const at = eventTime(event);
    const eventCode = text(event["codEvento"]);
    const rawStatus = text(event["desTextoResumen"]) ?? eventCode;
    return at === null || rawStatus === null
      ? []
      : [{ at, rawStatus, status: mapLocal(EVENT_STATUS, eventCode), location: null }];
  });
  const grams = num(raw["peso"]);
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
  const report = statusReporter(context);
  return trackOneByOne(barcodes, PLAUSIBLE, async (code) => {
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
