import type { Direction, ParcelStatus } from "../../domain/parcel.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export const CARRIER_ID = "seur";

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** SEUR situation codes seen on real parcels. Anything else is reported, never guessed. */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  SX010: "registered",
  SX001: "in_transit",
  LI567: "in_transit",
  LO001: "in_transit",
  SW189: "in_transit",
  // Announced for the shop, not collectable yet.
  LI569: "in_transit",
  LI574: "at_pickup_point",
  LC003: "out_for_delivery",
  LL003: "delivered",
  LL010: "delivered",
};

function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS_MAP[code] ?? null);
}

function partyName(party: unknown): string | null {
  const object = asObject(party);
  return text(object["razon_social"]) ?? text(object["nombre_contacto"]);
}

/** One account shipment as a snapshot, or null when it has no barcode. History is newest first. */
export function shipmentSnapshot(
  raw: Json,
  direction: Direction,
  report: (code: string) => void,
): ParcelSnapshot | null {
  const barcode = text(raw["clave_envio"]);
  if (barcode === null) {
    return null;
  }
  const situations = Array.isArray(raw["situaciones"]) ? (raw["situaciones"] as unknown[]) : [];
  const history: SnapshotEvent[] = [];
  for (const item of situations) {
    const event = asObject(item);
    const at = isoTime(event["fecha"]);
    const code = text(event["cod_situacion"]);
    if (at !== null && code !== null) {
      history.push({ at, status: mapCode(code), rawStatus: code, location: null });
    }
  }
  history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = history[0];
  const code = latest?.rawStatus ?? null;
  const status = mapCode(code);
  if (code !== null && status === null) {
    report(code);
  }
  const pickup = raw["tipo_entrega"] === "SHOP";
  const weight = raw["peso"];
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    direction,
    status,
    rawStatus: code,
    deliveredAt: status === "delivered" ? (latest?.at ?? null) : null,
    pickup,
    pickupPoint: pickup ? text(asObject(raw["destinatario"])["centro_seur"]) : null,
    sender: partyName(raw["remitente"]),
    receiver: partyName(raw["destinatario"]),
    weightKg: typeof weight === "number" && Number.isFinite(weight) ? weight : null,
    history,
    raw,
  });
}
