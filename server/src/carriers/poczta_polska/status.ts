import { ruleStatus, type ParcelStatus } from "../../plugin/api.js";

/*
 * Poczta Polska scan codes, from the shared table. Keyed on the scan code, never on the coarser
 * state label, which can lag behind a failed delivery.
 */

export function codeStatus(code: string | null): ParcelStatus | null {
  return ruleStatus("poczta_polska", code);
}
