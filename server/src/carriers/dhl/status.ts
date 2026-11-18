import { mapStatus, loadRules, type MappedStatus } from "open-parcels-rules";

/**
 * DHL status codes and texts come from the shared `open-parcels-rules` table, so every project
 * that tracks DHL agrees on them. Nothing is mapped locally except structural signals the table
 * cannot express (a Packstation flag, a return flag).
 */
export function mapDhl(raw: {
  readonly code?: string;
  readonly text?: string;
}): MappedStatus | null {
  return mapStatus(loadRules(), "dhl", raw);
}
