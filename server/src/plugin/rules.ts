/**
 * The parts of `open-parcels-rules` plug-ins use: the shared status tables, tracking-URL
 * templates, carrier lookup and Amazon's arrival phrases. Plug-ins reach them through the
 * plug-in API rather than importing the package, so the boundary stays in one place.
 */
import {
  loadRules,
  mapStatus,
  trackingUrl,
  type MappedStatus,
  type RawStatus,
} from "open-parcels-rules";

export {
  findCarrier,
  loadRules,
  mapStatus,
  parseArrival,
  resolveStatus,
  trackingUrl,
} from "open-parcels-rules";
export type {
  ArrivalOptions,
  ArrivalWindow,
  CarrierInfo,
  MappedStatus,
  RawStatus,
  ResolvedStatus,
  Rules,
} from "open-parcels-rules";

/** A raw carrier status mapped through the shared table for `carrier` (a rules id), or null. */
export function rulesStatus(carrier: string, raw: RawStatus): MappedStatus | null {
  return mapStatus(loadRules(), carrier, raw);
}

/** The shared tracking-page URL for `carrier` (a rules id), or undefined when it has none. */
export function rulesTrackingUrl(
  carrier: string,
  trackingNumber: string,
  locale?: string,
): string | undefined {
  return trackingUrl(loadRules(), carrier, trackingNumber, locale);
}
