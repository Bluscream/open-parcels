import { rulesStatus, type ParcelStatus } from "../../plugin/api.js";

/*
 * UPS status vocabularies, all in the shared rules (`ups`). Keys are prefixed by vocabulary
 * (`milestone:`, `scan:`, `type:`), because the three share no meaning: the public tracking's
 * locale-independent milestone keys, its scan activity codes, and the official API's activity
 * status types. A value the table maps to `unknown` is known and deliberately unmapped.
 */

export type Vocabulary = "milestone" | "scan" | "type";

export interface StatusLookup {
  readonly status: ParcelStatus | null;
  /** The table does not know the key; it is not one of the deliberately unmapped ones. */
  readonly unknown: boolean;
}

export function upsStatus(vocabulary: Vocabulary, key: string): StatusLookup {
  const mapped = rulesStatus("ups", { code: `${vocabulary}:${key}` });
  if (mapped === null) {
    return { status: null, unknown: true };
  }
  return { status: mapped.status === "unknown" ? null : mapped.status, unknown: false };
}
