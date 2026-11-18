import type { ParcelStatus } from "../../plugin/api.js";

/*
 * Poczta Polska scan codes. The shared rules have no table for this carrier yet; this one
 * belongs there and stays here only until it has moved. Keyed on the scan code, never on the
 * coarser state label, which can lag behind a failed delivery.
 */
const CODES: Readonly<Record<string, ParcelStatus>> = {
  P_REJ_KN1: "registered",
  P_PPDN: "in_transit",
  P_NAD: "in_transit",
  P_PZL: "in_transit",
  P_WZL: "in_transit",
  P_WEOC: "in_transit",
  P_WYPL: "in_transit",
  P_WYOC: "in_transit",
  P_WEPL: "in_transit",
  P_WPUCPP: "in_transit",
  P_ZWC: "in_transit",
  P_WD: "out_for_delivery",
  P_WDML: "out_for_delivery",
  P_NDD: "out_for_delivery",
  P_A: "at_pickup_point",
  P_KWD: "at_pickup_point",
  P_PA: "at_pickup_point",
  P_D: "delivered",
  P_OWU: "delivered",
  P_NDZ: "returning",
  P_ND: "problem",
  P_NDZK: "problem",
  P_NDPD: "problem",
  P_R: "problem",
  P_NDZAP: "problem",
  P_NDZKON: "problem",
  P_ZDUN: "problem",
  P_CZDKN: "problem",
  P_NDPJ: "problem",
};

export function codeStatus(code: string | null): ParcelStatus | null {
  return code === null ? null : (CODES[code] ?? null);
}
