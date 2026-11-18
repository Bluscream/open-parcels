import { ruleStatus, text, type Json, type ParcelStatus } from "../../plugin/api.js";

const CARRIER_ID = "canadapost";

/** Looks `value` up in one of the shared table's vocabularies (`status:`, `cd:`, `type:`). */
const lookUp = (vocabulary: string, value: string | null): ParcelStatus | null =>
  value === null ? null : ruleStatus(CARRIER_ID, `${vocabulary}:${value}`);

export const DELIVERED_EVENT_CODE = "1466";

/** The parcel-level `status` string; variants like `InTransit-xyz` fall back to their family. */
export function mapParcelStatus(value: string | null): ParcelStatus | null {
  return lookUp("status", value);
}

/** An event code outranks its type: one type covers several outcomes. */
export function mapEvent(event: Json): ParcelStatus | null {
  return (
    lookUp("cd", text(event["cd"])) ?? lookUp("type", text(event["type"])?.toUpperCase() ?? null)
  );
}

/**
 * The status string first; when it does not map, the newest event that does. A parcel on its
 * way back is `returning` whatever its status string says, unless it is already delivered.
 */
export function resolveStatus(
  detail: Json,
  newestFirst: readonly Json[],
  report: (code: string) => void,
): ParcelStatus | null {
  if (detail["delivered"] === true) {
    return "delivered";
  }
  const raw = text(detail["status"]);
  let status = mapParcelStatus(raw);
  if (status === null) {
    status = newestFirst.map(mapEvent).find((mapped) => mapped !== null) ?? null;
    if (status === null && raw !== null) {
      report(raw);
    }
  }
  const returned = detail["returnedToSender"] === true || detail["returnPinIndicator"] === true;
  return returned && status !== "delivered" ? "returning" : status;
}
