import { isoTime as kitIsoTime, text as kitText, type ParcelStatus } from "../../plugin/api.js";

export const CARRIER_ID = "paack";
export const TRACKING_HOST = "paack.co";

export { asObject, newestFirst, type Json } from "../../plugin/api.js";

/** Paack's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

/** Strings as `new Date()` reads them, numbers as epoch milliseconds. */
export const isoTime = (value: unknown): string | null =>
  kitIsoTime(value, { naive: "runtime", epoch: "ms" });
/**
 * Paack's event labels. Local until open-parcels-rules has a table for this carrier; prefer
 * mapping too little over mapping wrongly.
 */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  manifested: "registered",
  created: "registered",
  appointmentChangedToNextAvailableDay: "registered",
  scannedAtOrigin: "in_transit",
  receivedAtHub: "in_transit",
  sorted: "in_transit",
  warehouse: "in_transit",
  inDelivery: "out_for_delivery",
  driverAssigned: "out_for_delivery",
  inProgress: "out_for_delivery",
  readyForPickup: "at_pickup_point",
  atPickupPoint: "at_pickup_point",
  droppedInPudo: "at_pickup_point",
  delivered: "delivered",
  collectedByCustomer: "delivered",
  returnedToSender: "returning",
  returnedToRetailer: "returning",
  logisticIssueOpen: "problem",
  incorrectAddress: "problem",
  damaged: "problem",
  lost: "problem",
};

export function mapLabel(label: string | null): ParcelStatus | null {
  return label === null ? null : (STATUS_MAP[label] ?? null);
}

export function publicUrl(barcode: string, postalCode: string | null): string {
  const base = `https://${TRACKING_HOST}/shipments/tracking/order?tracking_number=${encodeURIComponent(barcode)}`;
  return postalCode === null ? base : `${base}&postal_code=${encodeURIComponent(postalCode)}`;
}
