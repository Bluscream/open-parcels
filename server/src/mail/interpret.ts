import {
  detectTrackingNumbers,
  parseMail,
  type MailParseResult,
  type Rules,
} from "open-parcels-rules";
import { snapshot, type ParcelSnapshot } from "../plugin/snapshot.js";
import type { MailInput, MailInterpreter } from "./types.js";

/** Shop id from a rule id such as `parcel-amazon` or `order-otto`. */
function shopOf(ruleId: string): string | null {
  const match = /^(?:parcel|order|return|dunning)-([a-z0-9]+)/.exec(ruleId);
  return match?.[1] ?? null;
}

function senderDomain(from: string): string | undefined {
  return /@([^>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
}

function carrierFor(
  rules: Rules,
  result: MailParseResult,
  trackingNumber: string,
  domain: string | undefined,
): string | null {
  if (result.carrier !== undefined) {
    return result.carrier;
  }
  const best = detectTrackingNumbers(
    rules,
    trackingNumber,
    domain === undefined ? undefined : { senderDomain: domain },
  )
    .filter((candidate) => candidate.trackingNumber === trackingNumber)
    .sort((a, b) => b.confidence - a.confidence)[0];
  return best === undefined || best.carrier === "upu" ? null : best.carrier;
}

/**
 * Turns shipping mails into parcel snapshots using the shared rules. Only mails that name a
 * tracking number produce a parcel; pickup codes are never carried over, because codes that open
 * a locker must not end up in stored data or events.
 */
export function createMailInterpreter(rules: Rules, timeZone: string): MailInterpreter {
  return (mail: MailInput): readonly ParcelSnapshot[] => {
    const results = parseMail(rules, {
      from: mail.from,
      subject: mail.subject,
      ...(mail.text === null ? {} : { text: mail.text }),
      ...(mail.html === null ? {} : { html: mail.html }),
      ...(mail.date === null ? {} : { date: mail.date }),
      timeZone,
    });
    const domain = senderDomain(mail.from);
    const at = (mail.date ?? new Date()).toISOString();
    const snapshots: ParcelSnapshot[] = [];
    for (const result of results) {
      if (result.kind !== "parcel") {
        continue;
      }
      const shop = shopOf(result.ruleId);
      const orderNumber = result.orderNumbers[0];
      for (const trackingNumber of result.trackingNumbers) {
        const carrier = carrierFor(rules, result, trackingNumber, domain);
        if (carrier === null) {
          continue;
        }
        const status = result.status ?? null;
        snapshots.push(
          snapshot({
            carrier,
            barcode: trackingNumber,
            status,
            rawStatus: mail.subject,
            plannedFrom: result.arrival?.from ?? null,
            plannedTo: result.arrival?.to ?? null,
            url: result.trackingUrl ?? null,
            history: [{ at, status, rawStatus: mail.subject, location: null }],
            items: (result.items ?? []).map((title) => ({
              title,
              imageUrl: null,
              url: null,
              externalId: null,
              quantity: null,
              price: null,
              currency: null,
            })),
            order:
              shop === null || orderNumber === undefined
                ? null
                : { shop, orderNumber, placedAt: null },
          }),
        );
      }
    }
    return snapshots;
  };
}
