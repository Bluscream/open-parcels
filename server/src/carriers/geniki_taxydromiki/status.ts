import { isoTime, ruleStatus, type ParcelStatus } from "../../plugin/api.js";

export interface Checkpoint {
  readonly code: string | null;
  readonly label: string | null;
  readonly at: string | null;
  readonly location: string | null;
}

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

/** A scan code, from the shared table. */
export function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus("geniki_taxydromiki", code);
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

/** The carrier stamps Greek wall-clock time without an offset; sentinel dates mean "none". */
export function localIso(value: unknown): string | null {
  if (typeof value !== "string" || value.startsWith("1900-") || value.startsWith("0001-")) {
    return null;
  }
  return isoTime(value, { naive: { zone: "Europe/Athens" }, dateOnly: false });
}
