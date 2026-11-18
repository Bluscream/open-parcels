import { rulesStatus, type ParcelStatus } from "../../plugin/api.js";

/*
 * PostNL track & trace observation codes and status-phase wording, from the shared table. Notice
 * and admin codes map to `unknown` there: they never move the parcel and inherit the stage
 * before them.
 */
const CARRIER_ID = "postnl";

/** An observation code's status; null for notices and unknown codes. */
export function observationStatus(code: string): ParcelStatus | null {
  const status = rulesStatus(CARRIER_ID, { code })?.status ?? null;
  return status === "unknown" ? null : status;
}

/** A notice or admin event: known, but it never moves the parcel. */
export function isMetaCode(code: string): boolean {
  return rulesStatus(CARRIER_ID, { code })?.status === "unknown";
}

/** Status-phase wording, for parcels without any recognised observation. First match wins. */
export function phaseStatus(message: string): ParcelStatus | null {
  const folded = message.toLowerCase().replace(/-/g, " ");
  return rulesStatus(CARRIER_ID, { text: folded })?.status ?? null;
}
