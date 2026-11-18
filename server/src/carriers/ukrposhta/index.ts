import { z } from "zod";
import type { PluginHttp } from "../../plugin/api.js";
import {
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { expectStatus, isObject, isoTime, readJson, text, type Json } from "../../plugin/api.js";

const CARRIER_ID = "ukrposhta";
const API_HOST = "www.ukrposhta.ua";
/** Event dates carry no offset; they are read as Kyiv wall-clock time. */
const ZONE = "Europe/Kyiv";
/** The public bearer the carrier's own tracking widget sends; it identifies no user. */
const PUBLIC_BEARER = "c3e02b53-3b1d-386e-b676-141ffa054c57";

type Status = NonNullable<ParcelSnapshot["status"]>;

/**
 * Numeric event codes. Belongs in the shared rules once an Ukrposhta table exists there. `24300`
 * (held at the inward office of exchange) is left out on purpose: it sits inside normal customs
 * runs, so it falls back to the previous mapped event.
 */
const CODES: Readonly<Record<string, Status>> = {
  ...Object.fromEntries(["10100", "10601", "17100"].map((code) => [code, "registered"])),
  ...Object.fromEntries(
    [
      "20700",
      "20800",
      "21500",
      "21600",
      "27200",
      "77600",
      "70800",
      "60700",
      "67300",
      "90800",
      "97700",
      "2201",
      "4006",
      "4021",
      "4024",
      "4074",
      "80700",
      "82700",
      "89000",
      "80800",
      "82800",
      "89100",
      "27900",
    ].map((code) => [code, "in_transit"]),
  ),
  "29500": "out_for_delivery",
  "21400": "at_pickup_point",
  "21700": "at_pickup_point",
  "31100": "problem",
  "31300": "problem",
  "31400": "problem",
  "31200": "returning",
  "41000": "delivered",
  "48000": "delivered",
};

/** A refused parcel's way back reuses the forward codes; everything from here on is the return. */
const RETURN_OPENING_CODE = "31200";
const RETURN_LABEL_PREFIX = "Return: ";
const BARCODE_PATTERN = /^[A-Z0-9]{8,20}$/i;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

/** The event list, oldest first; null when the carrier has no events for the code. */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json[] | null> {
  const url = new URL(`https://${API_HOST}/status-tracking/0.0.1/statuses`);
  url.searchParams.set("barcode", barcode);
  url.searchParams.set("lang", "en");
  const response = await http.request(url, {
    headers: { accept: "application/json", authorization: `Bearer ${PUBLIC_BEARER}` },
  });
  if (response.status === 401 || response.status === 403) {
    // The public bearer was refused: nothing the user can fix, and retrying will not help soon.
    throw new TransientError(
      `Ukrposhta refused the public tracking request (HTTP ${response.status}).`,
    );
  }
  if (response.status === 404) {
    return null;
  }
  expectStatus(response, "Ukrposhta", 200);
  const payload = readJson(response, "Ukrposhta");
  if (!Array.isArray(payload) || !payload.every(isObject)) {
    throw new UnexpectedResponseError("Ukrposhta did not answer with a list of events.");
  }
  return payload.length === 0 ? null : payload;
}

interface Classified {
  readonly event: Json;
  readonly code: string | null;
  readonly status: Status | null;
}

/** Pairs each event with its status; once a return leg opens, every later event is returning. */
export function classify(events: readonly Json[]): Classified[] {
  let returning = false;
  return events.map((event) => {
    const code = text(event["event"]);
    const name = text(event["eventName"]);
    returning ||= code === RETURN_OPENING_CODE || (name?.startsWith(RETURN_LABEL_PREFIX) ?? false);
    const status: Status | null = returning
      ? "returning"
      : code === null
        ? null
        : (CODES[code] ?? null);
    return { event, code, status };
  });
}

function rawText(event: Json): string | null {
  const parts = [text(event["event"]), text(event["eventName"])].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" ");
}

function history(classified: readonly Classified[]): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const { event, status } of classified) {
    const at = isoTime(event["date"], { naive: { zone: ZONE }, dateOnly: false });
    const rawStatus = rawText(event);
    if (at !== null && rawStatus !== null) {
      events.push({ at, status, rawStatus, location: null });
    }
  }
  return events.reverse();
}

export function ukrposhtaSnapshot(
  events: readonly Json[],
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const classified = classify(events);
  const final = classified.at(-1);
  if (final?.status === null && final.code !== null) {
    // Only numeric codes are reported; free text never reaches the report.
    report(/^\d+$/.test(final.code) ? final.code : "non-numeric");
  }
  // The final event, else the newest event that mapped.
  const status = [...classified].reverse().find((entry) => entry.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const deliveredEvent = delivered
    ? [...classified].reverse().find((entry) => entry.status === "delivered")
    : undefined;
  const code = text(final?.event["barcode"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: final === undefined ? null : rawText(final.event),
    delivered,
    deliveredAt:
      deliveredEvent === undefined
        ? null
        : isoTime(deliveredEvent.event["date"], { naive: { zone: ZONE }, dateOnly: false }),
    pickup: status === "at_pickup_point",
    url: `https://track.ukrposhta.ua/en/?barcode=${encodeURIComponent(code)}`,
    history: history(classified),
    raw: { trackingNumber: barcode, events },
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("event_code", code);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const events = await lookUp(context.http, barcode);
    if (events !== null) {
      snapshots.push(ukrposhtaSnapshot(events, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const ukrposhta = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Ukrposhta",
  countries: ["UA"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [API_HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
