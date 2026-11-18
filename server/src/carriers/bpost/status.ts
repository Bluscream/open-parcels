import type { ParcelStatus, StatusTable } from "../../plugin/api.js";

const all = (status: ParcelStatus, codes: readonly string[]): StatusTable =>
  Object.fromEntries(codes.map((code) => [code, status]));

/**
 * bpost's own process-step codes (`activeStep.knownProcessStep`). Candidates for the rules
 * repository: the same vocabulary also appears, case-flattened, as `activeStep.name`.
 */
export const BPOST_STEP: StatusTable = {
  // Announced or being prepared: bpost has the data, not the parcel.
  ...all("registered", [
    "IN_PREPARATION",
    "IN_PREPARATION_AWAITING_DROPOFF",
    "IN_PREPARATION_AWAITING_PICKUP",
    "IN_PREPARATION_AWAITING_PICKUPDROPOFF",
    "IN_PREPARATION_INTERNATIONAL",
    "IN_PREPARATION_INTERNATIONAL_AWAITING_DROPOFF",
    "IN_PREPARATION_INTERNATIONAL_AWAITING_PICKUP",
    "IN_PREPARATION_INTERNATIONAL_AWAITING_PICKUPDROPOFF",
    "PENDING_APPROVAL",
    "PREPARATION",
    "PREPARATION_AWAITING_DROPOFF",
    "PREPARATION_AWAITING_PICKUP",
    "PREPARATION_AWAITING_PICKUPDROPOFF",
    "STATUS_PENDING",
    "mpcPrinted",
  ]),
  // Moving through the network, customs included while nothing is owed.
  ...all("in_transit", [
    "AWAITING",
    "CUSTOMS",
    "CUSTOMS_PAYMENT_NOT_REQUIRED",
    "CUSTOMS_PAYMENT_SUCCESSFUL",
    "EXPECTED",
    "ON_THE_WAY",
    "PROCESSING",
    "PROCESSING_HOME",
    "PROCESSING_INTERNATIONAL",
    "PROCESSING_KARIBOO_POINT",
    "PROCESSING_OUTBOUND_ABROAD",
    "PROCESSING_OUTBOUND_ABROAD_PARCEL_LOCKER",
    "PROCESSING_OUTBOUND_ABROAD_POST_POINT",
    "PROCESSING_OUTBOUND_BPOST",
    "PROCESSING_PARCEL_LOCKER",
    "PROCESSING_PARCEL_LOCKER_AVISE",
    "PROCESSING_POST_OFFICE",
    "PROCESSING_POST_POINT",
    "PROCESSING_SECOND_PRESENTATION",
    "PROCESSING_SHOP",
  ]),
  // On today's round, to an address or to a pickup location.
  ...all("out_for_delivery", [
    "ON_THE_WAY_TO_KARIBOO_POINT",
    "ON_THE_WAY_TO_PARCEL_LOCKER",
    "ON_THE_WAY_TO_PARCIFY_HUB",
    "ON_THE_WAY_TO_POSTAL_OFFICE",
    "ON_THE_WAY_TO_POST_OFFICE",
    "ON_THE_WAY_TO_POST_POINT",
    "ON_THE_WAY_TO_SHOP",
    "ON_THE_WAY_TO_YOU",
    "OUT_FOR_DELIVERY_HOME",
    "OUT_FOR_DELIVERY_KARIBOO_POINT",
    "OUT_FOR_DELIVERY_PARCIFY_HUB",
    "OUT_FOR_DELIVERY_POST_OFFICE",
    "OUT_FOR_DELIVERY_POST_POINT",
    "out_for_delivery_onFoot",
    "out_for_delivery_byBike",
    "out_for_delivery_byCar",
    "out_for_delivery_byEbike",
    "out_for_delivery_byECar",
  ]),
  // Waiting to be collected.
  ...all("at_pickup_point", [
    "AVAILABLE",
    "AVAILABLE_ADVISED_POST_POINT",
    "AVAILABLE_INTERNATIONAL_PARCEL_LOCKER",
    "AVAILABLE_INTERNATIONAL_POST_POINT",
    "AVAILABLE_IN_KARIBOO_POINT",
    "AVAILABLE_IN_PARCEL_LOCKER",
    "AVAILABLE_IN_PARCEL_LOCKER_INTERNATIONAL",
    "AVAILABLE_IN_POST_OFFICE",
    "AVAILABLE_IN_POST_POINT",
    "AVAILABLE_IN_POST_POINT_INTERNATIONAL",
    "AVAILABLE_IN_SHOP",
    "AVAILABLE_KARIBOO_POINT",
    "AVAILABLE_PARCEL_LOCKER",
    "AVAILABLE_PARCEL_LOCKER_INTERNATIONAL",
    "AVAILABLE_POST_OFFICE",
    "AVAILABLE_POST_POINT",
    "AVAILABLE_POST_POINT_INTERNATIONAL",
    "AVAILABLE_SHOP",
    "REDELIVERY_CAN_PICKUP_POST_POINT",
  ]),
  // Handed over, dropped off or collected; a return leg that has arrived is terminal too.
  ...all("delivered", [
    "DELIVERED",
    "DELIVERED_AT_FORCED_NB",
    "DELIVERED_AT_FORCED_SP",
    "DELIVERED_AT_HOME",
    "DELIVERED_AT_NEIGHBOUR",
    "DELIVERED_IN_MAILBOX",
    "DELIVERED_MANUALLY",
    "DELIVERED_TO_KARIBOO",
    "DELIVERED_TO_SAFEPLACE",
    "PICKED_UP",
    "PICKED_UP_AT_INTERNATIONAL_PARCEL_LOCKER",
    "PICKED_UP_AT_INTERNATIONAL_POST_POINT",
    "PICKED_UP_IN_KARIBOO_POINT",
    "PICKED_UP_IN_PARCEL_LOCKER",
    "PICKED_UP_IN_PARCEL_LOCKER_INTERNATIONAL",
    "PICKED_UP_IN_POST_OFFICE",
    "PICKED_UP_IN_POST_POINT",
    "PICKED_UP_IN_POST_POINT_INTERNATIONAL",
    "PICKED_UP_IN_SHOP",
    "BTS_DELIVERED",
    "DELIVERED_TO_SENDER",
    "DELIVERED_TO_SENDER_RETURN",
    "PICKED_UP_BY_SENDER",
    "RETOUR_DELIVERED",
  ]),
  // Heading back to the sender; even "available" here is at the sender's point.
  ...all("returning", [
    "BTS_AVAILABLE_PARCEL_LOCKER",
    "BTS_AVAILABLE_POST_POINT",
    "BTS_OUT_FOR_DELIVERY_HOME",
    "BTS_OUT_FOR_DELIVERY_KARIBOO_POINT",
    "BTS_OUT_FOR_DELIVERY_PARCEL_LOCKER",
    "BTS_OUT_FOR_DELIVERY_POST_OFFICE",
    "BTS_OUT_FOR_DELIVERY_POST_POINT",
    "ON_THE_WAY_TO_SENDER",
    "OUT_FOR_DELIVERY_SENDER",
    "RETOUR_AVAILABLE_POST_POINT",
    "RETOUR_OUT_FOR_DELIVERY_HOME",
    "RETOUR_OUT_FOR_DELIVERY_KARIBOO_POINT",
    "RETOUR_OUT_FOR_DELIVERY_POST_OFFICE",
    "RETOUR_OUT_FOR_DELIVERY_POST_POINT",
    "RETURN_TO_SENDER",
    "RETURN_TO_SENDER_INTERNATIONAL",
  ]),
  // Stuck: money owed, a failed payment or a missed collection deadline.
  ...all("problem", [
    "AWAITING_CUSTOMS_PAYMENT",
    "CUSTOMS_PAYMENT_CHALLENGED",
    "CUSTOMS_PAYMENT_EXPIRED",
    "CUSTOMS_PAYMENT_REFUSED",
    "EXCEPTION",
    "REDELIVERY_NO_PICKUP",
  ]),
};

/** `activeStep.name` is the same vocabulary, case-flattened, plus two names of its own. */
const BY_NAME: StatusTable = {
  ...Object.fromEntries(
    Object.entries(BPOST_STEP).map(([code, status]) => [code.toLowerCase(), status]),
  ),
  delivered: "delivered",
  delivered_kariboo_point: "delivered",
};

/** Every leading `_`-segment prefix of a known name, for names bpost has not shown yet. */
const BY_PREFIX: StatusTable = (() => {
  const table: Record<string, ParcelStatus> = {};
  for (const [name, status] of Object.entries(BY_NAME)) {
    const segments = name.split("_");
    for (let length = 1; length <= segments.length; length += 1) {
      table[segments.slice(0, length).join("_")] ??= status;
    }
  }
  return table;
})();

/**
 * The step's own code first; then its name, exactly or by its longest known prefix. Codes
 * outside the vocabulary and prefix-only matches are reported, so the table can grow.
 */
export function stepStatus(
  knownProcessStep: string | null,
  name: string | null,
  report: (key: string) => void,
): ParcelStatus | null {
  const fromCode = knownProcessStep === null ? undefined : BPOST_STEP[knownProcessStep];
  if (fromCode !== undefined) {
    return fromCode;
  }
  if (knownProcessStep !== null) {
    report(`knownProcessStep:${knownProcessStep}`);
  }
  if (name === null) {
    return null;
  }
  const exact = BY_NAME[name] ?? BY_NAME[name.toLowerCase()];
  if (exact !== undefined) {
    return exact;
  }
  report(`activeStep:${name}`);
  const segments = name.toLowerCase().split("_");
  for (let length = segments.length; length > 0; length -= 1) {
    const prefix = BY_PREFIX[segments.slice(0, length).join("_")];
    if (prefix !== undefined) {
      return prefix;
    }
  }
  return null;
}
