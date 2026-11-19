import { createHash } from "node:crypto";
import {
  detectTrackingNumbers,
  mapStatus,
  parseMail,
  type MailParseResult,
  type Rules,
} from "open-parcels-rules";
import { isPlausibleOrder, shopFromDomain } from "../domain/order.js";
import type { ParcelStatus } from "../domain/parcel.js";
import { snapshot, type ParcelSnapshot } from "../plugin/snapshot.js";
import type { MailInput, MailInterpreter } from "./types.js";

/** Shop id from a rule id such as `parcel-amazon` or `order-otto`. */
function shopOf(ruleId: string): string | null {
  const match = /^(?:parcel|order|return|dunning)-([a-z0-9]+)/.exec(ruleId);
  return match?.[1] ?? null;
}

/**
 * The order a mail belongs to. A rule's shop is trusted only when the order number fits that
 * shop's format; otherwise the mail came from another shop that merely mentioned it, and the
 * sender's domain names the shop.
 */
export function orderOf(
  ruleId: string,
  orderNumber: string | undefined,
  domain: string | undefined,
): { shop: string; orderNumber: string; placedAt: null } | null {
  const ruled = shopOf(ruleId);
  if (ruled === null || orderNumber === undefined) {
    return null;
  }
  const shop = isPlausibleOrder(ruled, orderNumber) ? ruled : shopFromDomain(domain);
  return shop === null ? null : { shop, orderNumber, placedAt: null };
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

/** The carrier's status table read on the subject, when the mail rule's keywords found none. */
function textStatus(rules: Rules, carrier: string, subject: string): ParcelStatus | null {
  return subject.trim() === ""
    ? null
    : (mapStatus(rules, carrier, { text: subject })?.status ?? null);
}

/**
 * One identity per mail: its Message-ID, else a digest of what it says. A mail seen twice (in two
 * folders, or again after the server reset its UIDs) then gives one history entry, not two.
 */
function mailId(mail: MailInput): string {
  if (mail.messageId !== null && mail.messageId.trim() !== "") {
    return `mail:${mail.messageId.trim()}`;
  }
  const digest = createHash("sha256")
    .update([mail.from, mail.subject, mail.text ?? "", mail.html ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `mail:${digest}`;
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
    const id = mailId(mail);
    const snapshots: ParcelSnapshot[] = [];
    for (const result of results) {
      if (result.kind !== "parcel") {
        continue;
      }
      const order = orderOf(result.ruleId, result.orderNumbers[0], domain);
      for (const trackingNumber of result.trackingNumbers) {
        const carrier = carrierFor(rules, result, trackingNumber, domain);
        if (carrier === null) {
          continue;
        }
        const status = result.status ?? textStatus(rules, carrier, mail.subject);
        snapshots.push(
          snapshot({
            carrier,
            barcode: trackingNumber,
            status,
            rawStatus: mail.subject,
            plannedFrom: result.arrival?.from ?? null,
            plannedTo: result.arrival?.to ?? null,
            url: result.trackingUrl ?? null,
            history: [{ at, status, rawStatus: mail.subject, location: null, id }],
            items: (result.items ?? []).map((title) => ({
              title,
              imageUrl: null,
              url: null,
              externalId: null,
              quantity: null,
              price: null,
              currency: null,
            })),
            order,
          }),
        );
      }
    }
    return snapshots;
  };
}
