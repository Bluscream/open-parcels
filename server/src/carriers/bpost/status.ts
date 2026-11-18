import { ruleStatus, type ParcelStatus } from "../../plugin/api.js";

const CARRIER_ID = "bpost";

/**
 * The step's own code (`activeStep.knownProcessStep`) first; then its name, exactly or by its
 * longest known `_`-segment prefix. The vocabulary, the name-only entries ("name:") and the
 * prefixes ("prefix:") are the shared table's. Codes outside the vocabulary and prefix-only
 * matches are reported, so the table can grow.
 */
export function stepStatus(
  knownProcessStep: string | null,
  name: string | null,
  report: (key: string) => void,
): ParcelStatus | null {
  const fromCode = ruleStatus(CARRIER_ID, knownProcessStep);
  if (fromCode !== null) {
    return fromCode;
  }
  if (knownProcessStep !== null) {
    report(`knownProcessStep:${knownProcessStep}`);
  }
  if (name === null) {
    return null;
  }
  const exact =
    ruleStatus(CARRIER_ID, name) ?? ruleStatus(CARRIER_ID, `name:${name.toLowerCase()}`);
  if (exact !== null) {
    return exact;
  }
  report(`activeStep:${name}`);
  const segments = name.toLowerCase().split("_");
  for (let length = segments.length; length > 0; length -= 1) {
    const prefix = ruleStatus(CARRIER_ID, `prefix:${segments.slice(0, length).join("_")}`);
    if (prefix !== null) {
      return prefix;
    }
  }
  return null;
}
