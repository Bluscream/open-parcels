import {
  findCarrier,
  mapStatus,
  resolveStatus,
  type RawStatus,
  type Rules,
} from "open-parcels-rules";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import { arrivalWindow, parseClock, pastDay, zonedIso, type Day } from "./dates.js";
import { shipmentKey, type OrderTile, type TrackPage } from "./pages.js";
import type { Storefront } from "./storefronts.js";
import { foldText, maskDigits } from "./text.js";

export const AMAZON_ID = "amazon";

/**
 * Order lines that never count as a parcel: cancelled, refunded or returned. The rules' status
 * table has no "skip" outcome yet, so this minimal en/de list stays here until it does.
 */
const SKIP_PREFIXES = [
  "cancelled",
  "canceled",
  "return complete",
  "return started",
  "refund",
  "storniert",
  "erstattet",
  "rückgabe",
  "zurückgesendet",
] as const;

export function isSkipped(statusText: string): boolean {
  const folded = foldText(statusText);
  return SKIP_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

export function readsAsStatus(rules: Rules, text: string): boolean {
  return isSkipped(text) || mapStatus(rules, AMAZON_ID, { text }) !== null;
}

/**
 * Amazon's carrier codes for couriers that open-parcels tracks itself. A code missing here is
 * looked up in the rules' carrier registry by name; Amazon's own fleet never hands off.
 */
const CARRIER_CODES: Readonly<Record<string, string>> = {
  DHL_CONNECT: "dhl",
  DHL_DE: "dhl",
  DPD: "dpd",
  DPD_DE: "dpd",
  DPDDE: "dpd",
  HERMES: "hermes",
  HERMES_DE: "hermes",
  GLS: "gls",
  GLS_DE: "gls",
  UPS: "ups",
  ROYAL_MAIL: "royalmail",
  USPS: "usps",
};
const OWN_FLEET_RE = /^(?:AMZ|AMAZON|AMZL|SWA)/i;

/** `PluginContext.reportUnknown`: keys and codes only, never personal data. */
export type Reporter = (kind: string, key: string) => void;

/** The carrier a code names, `amazon` for Amazon's own fleet, or null when it is not known. */
export function carrierFor(rules: Rules, code: string | null, report: Reporter): string | null {
  if (code === null || OWN_FLEET_RE.test(code)) {
    return AMAZON_ID;
  }
  const known =
    CARRIER_CODES[code.toUpperCase()] ?? findCarrier(rules, code.replaceAll("_", " "))?.id;
  if (known === undefined) {
    report("carrier_code", code);
    return null;
  }
  return known;
}

export interface BuildInput {
  readonly rules: Rules;
  readonly storefront: Storefront;
  readonly tiles: readonly OrderTile[];
  readonly track: TrackPage | null;
  readonly trackPath: string | null;
  readonly now: Date;
  readonly report: Reporter;
}

function history(input: BuildInput, timeZone: string): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const event of input.track?.events ?? []) {
    const day: Day | null = pastDay(input.rules, event.dateText, input.now, timeZone);
    if (day === null) {
      input.report("event_date", maskDigits(event.dateText));
      continue;
    }
    const clock = parseClock(event.timeText) ?? { hour: 0, minute: 0 };
    const mapped = mapStatus(input.rules, AMAZON_ID, { text: event.message });
    if (mapped === null) {
      input.report("event_text", maskDigits(event.message));
    }
    events.push({
      at: zonedIso(day, clock.hour, clock.minute, timeZone),
      status: mapped?.status ?? null,
      rawStatus: event.message,
      location: event.location,
    });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The predicted window, cross-checked against the countdown to its end when the page has one. */
function plannedWindow(
  input: BuildInput,
  lead: OrderTile,
  timeZone: string,
): { from: string; to: string } | null {
  const promise = input.track?.promiseMessage ?? null;
  const fromPromise = arrivalWindow(input.rules, promise, input.now, timeZone);
  const countdown = input.track?.windowEndsInMs ?? null;
  if (fromPromise !== null) {
    const expectedEnd = input.now.getTime() + (countdown ?? 0);
    const plausible =
      countdown === null || Math.abs(Date.parse(fromPromise.to) - expectedEnd) <= 60 * 60_000;
    if (plausible) {
      return fromPromise;
    }
    input.report("delivery_window", maskDigits(promise ?? ""));
  }
  return arrivalWindow(input.rules, lead.statusText, input.now, timeZone);
}

function resolve(input: BuildInput, lead: OrderTile, events: readonly SnapshotEvent[]) {
  const milestone = input.track?.milestone ?? null;
  const shortStatus = input.track?.shortStatus ?? null;
  const fromShort =
    shortStatus === null ? null : mapStatus(input.rules, AMAZON_ID, { code: shortStatus });
  if (milestone !== null && mapStatus(input.rules, AMAZON_ID, { code: milestone }) === null) {
    input.report("milestone", milestone);
  }
  if (shortStatus !== null && fromShort === null) {
    input.report("short_status", shortStatus);
  }
  // Newest first: the milestone, then the page's short status, the timeline, the order line.
  const fallbacks: RawStatus[] = [
    ...(shortStatus === null ? [] : [{ code: shortStatus }]),
    ...events.map((event) => ({ text: event.rawStatus })),
    ...(lead.statusText === "" ? [] : [{ text: lead.statusText }]),
  ];
  const latest: RawStatus = milestone === null ? {} : { code: milestone };
  const resolved = resolveStatus(input.rules, AMAZON_ID, latest, fallbacks);
  if (resolved.source === "unknown" && lead.statusText !== "") {
    input.report("order_text", maskDigits(lead.statusText));
  }
  const pickup = resolved.status === "at_pickup_point" || fromShort?.pickup === true;
  return { status: resolved.status, pickup };
}

function deliveredAt(
  input: BuildInput,
  lead: OrderTile,
  events: readonly SnapshotEvent[],
  timeZone: string,
): string | null {
  const event = events.find((entry) => entry.status === "delivered");
  if (event !== undefined) {
    return event.at;
  }
  const day = pastDay(input.rules, lead.statusText, input.now, timeZone);
  return day === null ? null : zonedIso(day, 0, 0, timeZone);
}

function pageUrl(storefront: Storefront, path: string): string {
  return new URL(path, `https://www.${storefront.domain}/`).toString();
}

/** One snapshot for one shipment: the first order line speaks for the shipment's status. */
export function buildSnapshot(input: BuildInput): ParcelSnapshot | null {
  const lead = input.tiles[0];
  if (lead === undefined) {
    return null;
  }
  const track = input.track;
  const timeZone = track?.timeZone ?? input.storefront.timeZone;
  const events = history(input, timeZone);
  const { status, pickup } = resolve(input, lead, events);
  const delivered = status === "delivered";
  const window = delivered ? null : plannedWindow(input, lead, timeZone);
  const key = shipmentKey(lead);
  const trackingId = track?.trackingId ?? null;
  const carrier =
    track === null ? AMAZON_ID : carrierFor(input.rules, track.carrierCode, input.report);
  const handoff =
    trackingId !== null && carrier !== null && carrier !== AMAZON_ID
      ? { carrier, barcode: trackingId }
      : null;
  return snapshot({
    carrier: AMAZON_ID,
    barcode: trackingId ?? key,
    status,
    rawStatus: events[0]?.rawStatus ?? (lead.statusText === "" ? null : lead.statusText),
    delivered,
    deliveredAt: delivered ? deliveredAt(input, lead, events, timeZone) : null,
    plannedFrom: window?.from ?? null,
    plannedTo: window?.to ?? null,
    pickup,
    url: pageUrl(input.storefront, input.trackPath ?? lead.path),
    history: events,
    items: input.tiles.map((tile) => ({
      title: tile.title,
      imageUrl: null,
      url: null,
      externalId: tile.lineItemId === "" ? null : tile.lineItemId,
      quantity: null,
      price: null,
      currency: null,
    })),
    order: { shop: AMAZON_ID, orderNumber: lead.orderId, placedAt: null },
    externalRef: `${lead.orderId}/${key}`,
    handoff,
    raw: {
      storefront: input.storefront.domain,
      shipment: key,
      milestone: track?.milestone ?? null,
      shortStatus: track?.shortStatus ?? null,
      carrierCode: track?.carrierCode ?? null,
      orderStatus: lead.statusText === "" ? null : lead.statusText,
    },
    live:
      trackingId !== null && carrier === AMAZON_ID && !delivered
        ? {
            ref: {
              trackingId,
              csrfToken: track?.csrfToken ?? null,
              callout: track?.callout ?? null,
            },
            mapShown: track?.mapShown ?? false,
          }
        : null,
  });
}
