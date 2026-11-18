import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import { asObject, instantIso, num, objects, text, type Json } from "../../plugin/parse.js";
import { META_CODES, observationStatus, phaseStatus } from "./status.js";

export const CARRIER_ID = "postnl";
type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

interface Walked {
  readonly history: SnapshotEvent[];
  /** The stage the observations reach; null when none of them was recognised. */
  readonly stage: ParcelStatus | null;
  readonly deliveredAt: string | null;
  readonly unknownCodes: string[];
}

/**
 * Walks the observations oldest first. Milestones set the stage; notices inherit the stage
 * before them, so the history never jumps back on an ETA update. A parcel in track & trace has
 * at least been announced, so the walk starts at `registered`.
 */
function walk(observations: readonly Json[]): Walked {
  const ordered = observations
    .map((entry) => ({ entry, at: instantIso(entry["observationDate"]) }))
    .filter((item): item is { entry: Json; at: string } => item.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let stage: ParcelStatus = "registered";
  let recognised = false;
  let deliveredAt: string | null = null;
  const unknownCodes: string[] = [];
  const history: SnapshotEvent[] = [];
  for (const { entry, at } of ordered) {
    const code = text(entry["observationCode"]) ?? "";
    let status = observationStatus(code);
    if (status !== null) {
      stage = status;
      recognised = true;
      deliveredAt = status === "delivered" ? at : deliveredAt;
    } else if (META_CODES.has(code)) {
      status = stage;
      recognised = true;
    } else if (code !== "") {
      unknownCodes.push(code);
    }
    const description = text(entry["description"]) ?? code;
    if (description !== "") {
      history.push({ at, status, rawStatus: description, location: null });
    }
  }
  return {
    history: history.reverse(),
    stage: recognised ? stage : null,
    deliveredAt,
    unknownCodes,
  };
}

/** The colli's full timeline when PostNL sends it, else the shortened recent list. */
const observationsOf = (colli: Json): Json[] => {
  const all = objects(asObject(colli["analyticsInfo"])["allObservations"]);
  return all.length > 0 ? all : objects(colli["observations"]);
};

interface Window {
  readonly from: string | null;
  readonly to: string | null;
}

/** The route's window, sharpened to PostNL's own ETA when it falls inside it. */
function plannedWindow(shipment: Json, colli: Json): Window {
  const route = asObject(colli["routeInformation"]);
  const eta = asObject(colli["eta"]);
  if (Object.keys(route).length > 0) {
    const window = asObject(route["plannedDeliveryTimeWindow"]);
    const from = instantIso(window["startDateTime"]);
    const to = instantIso(window["endDateTime"]);
    const expected = instantIso(route["expectedDeliveryTime"]);
    const inside =
      expected !== null &&
      from !== null &&
      to !== null &&
      Date.parse(from) <= Date.parse(expected) &&
      Date.parse(expected) <= Date.parse(to);
    return { from: inside ? expected : from, to };
  }
  if (Object.keys(eta).length > 0) {
    return { from: instantIso(eta["start"]), to: instantIso(eta["end"]) };
  }
  return {
    from: instantIso(shipment["deliveryWindowFrom"]),
    to: instantIso(shipment["deliveryWindowTo"]),
  };
}

export interface ShipmentInput {
  readonly shipment: Json;
  readonly direction: ParcelSnapshot["direction"];
  /** The shipment's track & trace colli, or null when it was not (or could not be) read. */
  readonly colli: Json | null;
}

export function shipmentSnapshot(
  input: ShipmentInput,
  report: (kind: string, key: string) => void,
): ParcelSnapshot {
  const { shipment, colli } = input;
  const details = colli ?? {};
  const walked = walk(observationsOf(details));
  for (const code of walked.unknownCodes) {
    report("observation_code", code);
  }
  const phase = text(asObject(details["statusPhase"])["message"]);
  let status: ParcelStatus | null = walked.stage ?? (phase === null ? null : phaseStatus(phase));
  if (walked.stage === null && phase !== null && status === null) {
    report("status_text", phase);
  }
  if (shipment["delivered"] === true) {
    status = "delivered";
  }
  const delivered = status === "delivered";
  const window = delivered ? { from: null, to: null } : plannedWindow(shipment, details);
  const dimensions = asObject(asObject(details["details"])["dimensions"]);
  const grams = num(dimensions["weight"]);
  const receiverTitle = text(shipment["receiverTitle"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: text(shipment["barcode"]) ?? "",
    direction: input.direction,
    status,
    rawStatus: phase ?? (delivered ? "Pakket is bezorgd" : null),
    delivered,
    deliveredAt: delivered
      ? (instantIso(shipment["deliveredTimeStamp"]) ?? walked.deliveredAt)
      : null,
    plannedFrom: window.from,
    plannedTo: window.to,
    pickup: shipment["deliveryAddressType"] === "ServicePoint",
    url: text(shipment["detailsUrl"]),
    sender: text(shipment["title"]),
    receiver:
      text(asObject(asObject(details["recipient"])["names"])["personName"]) ?? receiverTitle,
    weightKg: grams !== null && grams > 0 ? grams / 1000 : null,
    history: walked.history,
    externalRef: text(shipment["key"]),
    raw: { shipment, colli },
  });
}
