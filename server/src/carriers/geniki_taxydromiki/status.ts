import type { ParcelSnapshot } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

export interface Checkpoint {
  readonly code: string | null;
  readonly label: string | null;
  readonly at: string | null;
  readonly location: string | null;
}

/** Scan codes. Candidates for the shared rules package. */
const STATUS: Readonly<Record<string, ParcelStatus>> = {
  C_NW: "registered",
  C_SC: "registered",
  C_W3: "in_transit",
  C_KK: "in_transit",
  C_K8: "in_transit",
  C_H1: "in_transit",
  C_H2: "in_transit",
  C_A1: "in_transit",
  C_L1: "in_transit",
  C_A3: "out_for_delivery",
  C_W2: "delivered",
  C_P1: "delivered",
  C_S2: "delivered",
  C_EA_DP: "problem",
  C_EA_KS: "problem",
};

/** A scan that withdraws an earlier one: the pair cancels out. */
const RETRACTS: Readonly<Record<string, string>> = { C_L2: "C_L1", C_E2: "C_E1", C_K9: "C_K8" };
/** Scans that undo an earlier delivery scan. */
const UNDO_DELIVERY = new Set(["C_P4", "C_S5", "C_S8"]);

/** Codes with a meaning of their own that are deliberately not mapped to a status. */
export const CONTROL_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(RETRACTS),
  ...Object.values(RETRACTS),
  ...UNDO_DELIVERY,
]);

export function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : (STATUS[code] ?? null);
}

/** The newest mapped scan that is not cancelled by a later one. Checkpoints are oldest first. */
export function decidingCode(checkpoints: readonly Checkpoint[]): string | null {
  const retracted: string[] = [];
  let deliveryUndone = false;
  for (const { code } of [...checkpoints].reverse()) {
    if (code === null) {
      continue;
    }
    const target = RETRACTS[code];
    if (target !== undefined) {
      retracted.push(target);
      continue;
    }
    const index = retracted.indexOf(code);
    if (index !== -1) {
      retracted.splice(index, 1);
      continue;
    }
    if (UNDO_DELIVERY.has(code)) {
      deliveryUndone = true;
      continue;
    }
    const mapped = mapCode(code);
    if (mapped !== null && !(mapped === "delivered" && deliveryUndone)) {
      return code;
    }
  }
  return null;
}

const ZONE = "Europe/Athens";
const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  timeZoneName: "longOffset",
});

/** Offset of the zone at an instant, in minutes east of UTC. */
function offsetMinutes(at: number): number {
  const name = offsetFormat.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) {
    return 0;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The carrier stamps Greek wall-clock time without an offset; sentinel dates mean "none". */
export function localIso(value: unknown): string | null {
  if (typeof value !== "string" || value.startsWith("1900-") || value.startsWith("0001-")) {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(value);
  if (match === null) {
    return null;
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  if (hasZone) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const asUtc = Date.parse(`${match[1] ?? ""}T${match[2] ?? ""}Z`);
  if (Number.isNaN(asUtc)) {
    return null;
  }
  // Two passes settle the offset around a daylight-saving change.
  const first = asUtc - offsetMinutes(asUtc) * 60_000;
  return new Date(asUtc - offsetMinutes(first) * 60_000).toISOString();
}
