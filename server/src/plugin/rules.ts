/**
 * The parts of `open-parcels-rules` plug-ins use: the shared status tables, tracking-URL
 * templates, tracking-number shapes, fixed public carrier keys, carrier lookup and Amazon's
 * arrival phrases. Plug-ins reach them through the plug-in API rather than importing the
 * package, so the boundary stays in one place.
 */
import {
  findCarrier,
  findCarrierKey,
  loadRules,
  mapStatus,
  trackingUrl,
  type MappedStatus,
  type RawStatus,
} from "open-parcels-rules";
import { PluginError } from "./errors.js";

export {
  findCarrier,
  ignoredStatus,
  loadRules,
  mapStatus,
  parseArrival,
  pastDayOffset,
  resolveStatus,
  trackingUrl,
} from "open-parcels-rules";
export type {
  ArrivalOptions,
  ArrivalWindow,
  CarrierInfo,
  MailEvent,
  MappedStatus,
  RawStatus,
  ResolvedStatus,
  Rules,
} from "open-parcels-rules";

type RuleStatus = MappedStatus["status"];

/**
 * The bundled rules lack a value the plug-in cannot work without. This is a packaging error,
 * never something to fall back from or to ask the user about.
 */
export class RulesConfigurationError extends PluginError {
  override readonly name = "RulesConfigurationError";
}

/** A raw carrier status mapped through the shared table for `carrier` (a rules id), or null. */
export function rulesStatus(carrier: string, raw: RawStatus): MappedStatus | null {
  return mapStatus(loadRules(), carrier, raw);
}

function reported(
  mapped: MappedStatus | null,
  key: string,
  report?: (key: string) => void,
): RuleStatus | null {
  if (mapped === null) {
    report?.(key);
    return null;
  }
  return mapped.status;
}

/**
 * A raw status code looked up in the shared table for `carrier`. Empty values give null; an
 * unmapped value gives null and is passed to `report`, when one is given.
 */
export function ruleStatus(
  carrier: string,
  code: string | null,
  report?: (key: string) => void,
): RuleStatus | null {
  return code === null ? null : reported(rulesStatus(carrier, { code }), code, report);
}

/** Like `ruleStatus`, for a status text matched against the table's text entries. */
export function ruleTextStatus(
  carrier: string,
  text: string | null,
  report?: (key: string) => void,
): RuleStatus | null {
  return text === null ? null : reported(rulesStatus(carrier, { text }), text, report);
}

/** Like `ruleStatus`, for named raw fields matched against the table's `fields` entries. */
export function ruleFieldsStatus(
  carrier: string,
  fields: Readonly<Record<string, string>>,
): RuleStatus | null {
  return rulesStatus(carrier, { fields })?.status ?? null;
}

/** The shared tracking-page URL for `carrier` (a rules id), or undefined when it has none. */
export function rulesTrackingUrl(
  carrier: string,
  trackingNumber: string,
  locale?: string,
): string | undefined {
  return trackingUrl(loadRules(), carrier, trackingNumber, locale);
}

/**
 * A fixed public value the carrier expects from every client (website or app key, client id,
 * app version, User-Agent). Throws when the rules do not list it; there is no fallback.
 */
export function carrierKey(carrierId: string, name: string): string {
  const key = findCarrierKey(loadRules(), carrierId, name);
  if (key === undefined) {
    throw new RulesConfigurationError(
      `The bundled open-parcels-rules list no key "${name}" for carrier "${carrierId}".`,
    );
  }
  return key.value;
}

/** The shape of a number `carrierId`'s tracker accepts. Throws when the rules lack it. */
export function carrierPattern(carrierId: string): RegExp {
  const pattern = findCarrier(loadRules(), carrierId)?.trackingNumberPattern;
  if (pattern === undefined) {
    throw new RulesConfigurationError(
      `The bundled open-parcels-rules list no tracking-number pattern for "${carrierId}".`,
    );
  }
  return pattern;
}
