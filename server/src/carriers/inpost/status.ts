import type { ParcelStatus } from "../../plugin/api.js";

/*
 * Local status tables. The shared rules have no InPost table yet; these belong there and stay
 * here only until they have moved. Keys are lower case; lookups fold case.
 */

/** The Polish account inbox: detailed `status`, also used by its event log entries' `name`. */
export const INBOX_STATUSES: Readonly<Record<string, ParcelStatus>> = {
  created: "registered",
  confirmed: "registered",
  dispatched_by_sender: "registered",
  dispatched_by_sender_to_pok: "registered",
  // The courier collected the parcel from the sender; it is far from delivered.
  taken_by_courier: "in_transit",
  taken_by_courier_from_pok: "in_transit",
  collected_from_sender: "in_transit",
  adopted_at_source_branch: "in_transit",
  sent_from_source_branch: "in_transit",
  adopted_at_sorting_center: "in_transit",
  sent_from_sorting_center: "in_transit",
  adopted_at_target_branch: "in_transit",
  redirect_to_box: "in_transit",
  permanently_redirected_to_box_machine: "in_transit",
  permanently_redirected_to_customer_service_point: "in_transit",
  readdressed: "in_transit",
  out_for_delivery: "out_for_delivery",
  out_for_delivery_to_address: "out_for_delivery",
  ready_to_pickup: "at_pickup_point",
  ready_for_collection: "at_pickup_point",
  ready_to_pickup_from_branch: "at_pickup_point",
  ready_to_pickup_from_pok: "at_pickup_point",
  ready_to_pickup_from_pok_registered: "at_pickup_point",
  stack_in_box_machine: "at_pickup_point",
  stack_in_customer_service_point: "at_pickup_point",
  pickup_reminder_sent: "at_pickup_point",
  pickup_reminder_sent_address: "at_pickup_point",
  // Despite the name, still collectible from the temporary locker.
  stack_parcel_in_box_machine_pickup_time_expired: "at_pickup_point",
  delivered: "delivered",
  collected_by_customer: "delivered",
  claimed: "delivered",
  returned_to_sender: "returning",
  return_pickup_confirmation_to_sender: "returning",
  delay_in_delivery: "problem",
  delivery_attempt_failed: "problem",
  rejected_by_receiver: "problem",
  not_collected: "problem",
  missing: "problem",
  oversized: "problem",
  canceled: "problem",
  cancelled: "problem",
  pickup_time_expired: "problem",
  stack_parcel_pickup_time_expired: "problem",
  // A bare notice after the receiver turned the parcel away, not a "ready" state.
  avizo: "problem",
  avizo_rejected: "problem",
  undelivered: "problem",
  undelivered_cod_cash_receiver: "problem",
  undelivered_incomplete_address: "problem",
  undelivered_lack_of_access_letterbox: "problem",
  undelivered_no_mailbox: "problem",
  undelivered_not_live_address: "problem",
  undelivered_unknown_receiver: "problem",
  undelivered_wrong_address: "problem",
};

/** The Polish inbox's coarse `statusGroup`, used when the detailed status is unknown. */
export const INBOX_GROUPS: Readonly<Record<string, ParcelStatus>> = {
  to_send: "registered",
  in_delivery: "in_transit",
  to_pickup: "at_pickup_point",
  delivered: "delivered",
};

/** Cash-on-delivery payment events: they say nothing about where the parcel is. */
export const PAYMENT_STATUSES: ReadonlySet<string> = new Set(["cod_completed", "c2x_completed"]);

/** The Italian inbox's event status catalogue. */
export const GROUP_STATUSES: Readonly<Record<string, ParcelStatus>> = {
  at_the_origin: "registered",
  in_transit: "in_transit",
  in_transit_last_mile: "out_for_delivery",
  awaiting_collection: "at_pickup_point",
  delivered: "delivered",
  not_delivered: "problem",
  exception: "problem",
  return: "returning",
};

/** The public cross-border tracking codes. */
export const TRACKING_STATUSES: Readonly<Record<string, ParcelStatus>> = {
  "cre.1001": "registered",
  "fmd.1001": "registered",
  "fmd.1002": "in_transit",
  "mmd.1001": "in_transit",
  "mmd.1002": "in_transit",
  "mmd.1003": "in_transit",
  "mmd.1004": "in_transit",
  "lmd.1001": "in_transit",
  "lmd.1002": "in_transit",
  "lmd.3006": "in_transit",
  "lmd.3014": "in_transit",
  "lmd.1004": "at_pickup_point",
  "lmd.1005": "at_pickup_point",
  "lmd.9001": "at_pickup_point",
  "lmd.9002": "problem",
  "lmd.9014": "returning",
  "eol.1001": "delivered",
  "eol.1003": "delivered",
  "eol.9001": "problem",
  "rts.1001": "returning",
  "rts.1002": "returning",
};
