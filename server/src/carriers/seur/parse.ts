import {
  ruleStatus,
  asObject,
  isoTime,
  snapshot,
  text,
  type Direction,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "seur";

/** SEUR's fields are strings; a number is never read as text. */
export const STRINGS = { numbers: false } as const;
/** SEUR dates are read as the runtime's `Date` reads them; numbers are not timestamps. */
const TIME = { naive: "runtime" } as const;

function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus("seur", code);
}

function partyName(party: unknown): string | null {
  const object = asObject(party);
  return text(object["razon_social"], STRINGS) ?? text(object["nombre_contacto"], STRINGS);
}

/** One account shipment as a snapshot, or null when it has no barcode. History is newest first. */
export function shipmentSnapshot(
  raw: Json,
  direction: Direction,
  report: (code: string) => void,
): ParcelSnapshot | null {
  const barcode = text(raw["clave_envio"], STRINGS);
  if (barcode === null) {
    return null;
  }
  const situations = Array.isArray(raw["situaciones"]) ? (raw["situaciones"] as unknown[]) : [];
  const history: SnapshotEvent[] = [];
  for (const item of situations) {
    const event = asObject(item);
    const at = isoTime(event["fecha"], TIME);
    const code = text(event["cod_situacion"], STRINGS);
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
    pickupPoint: pickup ? text(asObject(raw["destinatario"])["centro_seur"], STRINGS) : null,
    sender: partyName(raw["remitente"]),
    receiver: partyName(raw["destinatario"]),
    weightKg: typeof weight === "number" && Number.isFinite(weight) ? weight : null,
    history,
    raw,
  });
}
