import { rulesStatus, type ParcelStatus, type StatusTable } from "../../plugin/api.js";

/*
 * UPS status vocabularies. The shared rules have no UPS table yet; these belong there and are only
 * kept here until they move. `rulesStatus("ups", …)` is asked first, so a table published later
 * takes over without a code change. Rules keys are prefixed by vocabulary (`milestone:`, `scan:`,
 * `type:`), because the three share no meaning.
 */

/**
 * Public tracking milestone keys (`nameKey`). Locale-independent, unlike the display texts beside
 * them, so only these are mapped.
 */
const MILESTONES: StatusTable = {
  "cms.stapp.orderReceived": "registered",
  "cms.stapp.readyForShpmt": "registered",
  "cms.stapp.returnLabelCreated": "registered",
  "cms.stapp.weHaveYourPkg": "in_transit",
  "cms.stapp.inTransit": "in_transit",
  "cms.stapp.shipped": "in_transit",
  "cms.stapp.collected": "in_transit",
  "cms.stapp.pickedUpByUPS": "in_transit",
  "cms.stapp.clearedCustoms": "in_transit",
  "cms.stapp.clearedImprtCustoms": "in_transit",
  "cms.stapp.tenderedToUPSDeliveryAgent": "in_transit",
  // Address changes the user most likely asked for themselves: routine, not a problem.
  "cms.stapp.addressChangeRequested": "in_transit",
  "cms.stapp.addressChangeRequestCompleted": "in_transit",
  // The sender dropped it off at an access point; the recipient side has its own keys.
  "cms.stapp.dropoffAccessPoint": "in_transit",
  "cms.stapp.outForDelivery": "out_for_delivery",
  "cms.stapp.pkgIsReadyForPickup": "at_pickup_point",
  "cms.stapp.deliveredToUAP": "at_pickup_point",
  "cms.stapp.pkgReadyForPickupAP": "at_pickup_point",
  "cms.stapp.pkgIsAvailForPickup": "at_pickup_point",
  "cms.stapp.awaitingCustomerpickup": "at_pickup_point",
  "cms.stapp.delToUPSLoc": "at_pickup_point",
  "cms.stapp.delivered": "delivered",
  "cms.stapp.pkgIsDel": "delivered",
  "cms.stapp.shipmentIsDelivered": "delivered",
  "cms.stapp.customerPickUp": "delivered",
  "cms.stapp.rfidConfirmedPickUp": "delivered",
  "cms.stapp.uspsTrackingDeliveredMsg1": "delivered",
  "cms.stapp.uspsDeliveredMsg": "delivered",
  "cms.stapp.returned": "returning",
  "cms.stapp.retnToSender": "returning",
  "cms.stapp.deliveryRefused": "returning",
  ...Object.fromEntries(
    [
      "packageHalted",
      "investigationOpened",
      "investigationClosed",
      "delAttpted",
      "fnlDelAttpted",
      "secondryDeliveryAttempted",
      "postOfficeAttemptedDelivery",
      "finalDeliveryAttempt",
      "pkpUpAttempted",
      "secondPkpUpAttempted",
      "finalPkpUpAttempted",
      "pkpUpCanceled",
      "shipmentVoided",
      "incompleteDocumentationReceived",
      "shipmentClearencePending",
    ].map((key) => [`cms.stapp.${key}`, "problem" as const]),
  ),
};

/**
 * Scan activity codes (`actCode`), for the many scans without a milestone. Learned from the scan
 * sentences UPS pairs with each code, not from UPS's developer status-code list, which is another
 * vocabulary that happens to share the two-letter shape.
 */
const SCANS: StatusTable = {
  MP: "registered",
  ...Object.fromEntries(
    [
      "PU",
      "OR",
      "AR",
      "SS",
      "DP",
      "WH",
      "DA",
      "HL",
      "HM",
      "YP",
      "DS",
      "EP",
      "IP",
      "XD",
      "77",
      "1C",
      "1D",
      "VK",
      "H5",
      "O1",
      "VM",
    ].map((code) => [code, "in_transit" as const]),
  ),
  OT: "out_for_delivery",
  FS: "delivered",
  KB: "delivered",
  AM: "returning",
  AQ: "returning",
  KR: "returning",
  UA: "returning",
  // Something is stuck or someone must act; codes UPS only emits around an exception stay a
  // problem even when the sentence reports the resolution.
  ...Object.fromEntries(
    [
      "48",
      "49",
      "9F",
      "C5",
      "7F",
      "BH",
      "SL",
      "BE",
      "FF",
      "UP",
      "MF",
      "H1",
      "R4",
      "XV",
      "XN",
      "B3",
      "DB",
      "Z1",
    ].map((code) => [code, "problem" as const]),
  ),
};

/** Scan codes known and deliberately unmapped (an intention, a request, a renumbering). Silent. */
const QUIET_SCANS = new Set(["CG", "S7", "ZO", "EU"]);

/** Official API activity status types. */
const TYPES: StatusTable = {
  M: "registered",
  MV: "registered",
  P: "in_transit",
  I: "in_transit",
  W: "in_transit",
  O: "out_for_delivery",
  D: "delivered",
  DD: "delivered",
  DO: "delivered",
  RS: "returning",
  X: "problem",
};

export type Vocabulary = "milestone" | "scan" | "type";

const TABLES: Readonly<Record<Vocabulary, StatusTable>> = {
  milestone: MILESTONES,
  scan: SCANS,
  type: TYPES,
};

export interface StatusLookup {
  readonly status: ParcelStatus | null;
  /** Neither the rules nor the local table know the key, and it is not deliberately unmapped. */
  readonly unknown: boolean;
}

export function upsStatus(vocabulary: Vocabulary, key: string): StatusLookup {
  const fromRules = rulesStatus("ups", { code: `${vocabulary}:${key}` });
  if (fromRules !== null) {
    return { status: fromRules.status, unknown: false };
  }
  const table = TABLES[vocabulary];
  const local = Object.hasOwn(table, key) ? table[key] : undefined;
  if (local !== undefined) {
    return { status: local, unknown: false };
  }
  return { status: null, unknown: !(vocabulary === "scan" && QUIET_SCANS.has(key)) };
}
