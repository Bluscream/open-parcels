import { z } from "zod";
import {
  type PluginHttp,
  asArray,
  asObject,
  defineCarrier,
  isObject,
  isoTime,
  isTimeZone,
  newestFirst,
  readObject,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type StatusTable,
} from "../../plugin/api.js";

const CARRIER_ID = "apple_express";
const API_HOST = "trackapi.appleexpress.com";
const PLAUSIBLE = /^[A-Z0-9-]{4,40}$/i;
/** Its times carry no offset; it delivers in Ontario and Quebec, so Eastern time by default. */
const DEFAULT_ZONE = "America/Toronto";
/** The estimate names the end of a six-hour delivery window. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

export const APPLE_EXPRESS_STATUS: StatusTable = {
  "Order Created": "registered",
  "Order Request Received": "registered",
  "Waiting for Parcel": "registered",
  "Pending Delivery Notification Sent": "registered",
  "Delivery Notification Sent": "registered",
  "Package Picked Up": "in_transit",
  "Picked Up": "in_transit",
  "Received at Local Sort Facility": "in_transit",
  "Parcel Received, Out for Delivery Soon": "in_transit",
  "Returned for Next Attempt": "in_transit",
  "Second Attempt Planned": "in_transit",
  "Out for Delivery": "out_for_delivery",
  Delivered: "delivered",
  "Exception - No Answer": "problem",
  "Exception - No Suite or Unit Number": "problem",
  "FSA Not Serviced": "problem",
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** "November 20, 2026 02:00 PM" after a fixed prefix such as "Estimated Delivery:". */
const SENTENCE_TIME = /^([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/i;

/** Reads the display sentence's time, only after the exact prefix given. */
export function sentenceTime(value: unknown, prefix: string, zone: string): string | null {
  const sentence = text(value);
  if (sentence?.startsWith(prefix) !== true) {
    return null;
  }
  const match = SENTENCE_TIME.exec(sentence.slice(prefix.length).trim());
  const month = MONTHS.indexOf((match?.[1] ?? "").toLowerCase()) + 1;
  const hour = Number(match?.[4]);
  if (match === null || month === 0 || hour < 1 || hour > 12) {
    return null;
  }
  return zonedIso(
    {
      year: Number(match[3]),
      month,
      day: Number(match[2]),
      hour: (hour % 12) + ((match[6] ?? "").toUpperCase() === "PM" ? 12 : 0),
      minute: Number(match[5]),
    },
    zone,
  );
}

async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const response = await http.request(
    new URL(`https://${API_HOST}/api/track/order/${encodeURIComponent(barcode)}/language/en`),
    { headers: { accept: "application/json" } },
  );
  if (response.status !== 200) {
    throw new TransientError(`Apple Express tracking answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "Apple Express tracking");
  // An unknown code is HTTP 200 with the sections present and explicitly null.
  if (
    "orderDetails" in payload &&
    payload["orderDetails"] === null &&
    (payload["statusDetails"] ?? null) === null
  ) {
    return null;
  }
  if (!isObject(payload["orderDetails"]) || !Array.isArray(payload["statusDetails"])) {
    throw new UnexpectedResponseError("Apple Express tracking answered without order or status.");
  }
  return payload;
}

export function appleExpressSnapshot(
  raw: Json,
  barcode: string,
  zone: string,
  report: (status: string) => void,
): ParcelSnapshot {
  const order = asObject(raw["orderDetails"]);
  const current = text(order["currentStatus"]);
  const status = current === null ? null : (APPLE_EXPRESS_STATUS[current] ?? null);
  const history: SnapshotEvent[] = [];
  const unmapped = new Set<string>();
  for (const entry of asArray(raw["statusDetails"])) {
    const event = asObject(entry);
    const code = text(event["status"]);
    const at = isoTime(event["generatedAt"], { naive: { zone } });
    if (code !== null && APPLE_EXPRESS_STATUS[code] === undefined) {
      unmapped.add(code);
    }
    const rawStatus = text(event["statusDescriptionOverride"]) ?? code;
    if (at !== null && rawStatus !== null) {
      history.push({
        at,
        rawStatus,
        status: code === null ? null : (APPLE_EXPRESS_STATUS[code] ?? null),
        location: null,
      });
    }
  }
  if (current !== null && status === null) {
    unmapped.add(current);
  }
  unmapped.forEach(report);
  const delivered = status === "delivered";
  const windowEnd = delivered
    ? null
    : sentenceTime(order["statusChangeText"], "Estimated Delivery:", zone);
  const code = text(order["appleTrackingNumber"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: current,
    delivered,
    deliveredAt: delivered ? sentenceTime(order["statusChangeText"], "Delivered ", zone) : null,
    plannedFrom:
      windowEnd === null ? null : new Date(Date.parse(windowEnd) - WINDOW_MS).toISOString(),
    plannedTo: windowEnd,
    url: `https://track.appleexpress.com/en-US/orderNumber/${encodeURIComponent(code)}`,
    history: newestFirst(history),
    raw,
  });
}

const configSchema = z.looseObject({
  timeZone: z
    .string()
    .refine(isTimeZone, "Not a known time zone.")
    .optional()
    .describe("Time zone of the delivery area; Apple Express times carry no offset."),
});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

export const appleExpress = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Apple Express",
  countries: ["CA"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  // The tracker allows 25 lookups per code per hour; this stays far below that.
  http: {
    limits: { [API_HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, barcode);
      return raw === null
        ? null
        : appleExpressSnapshot(raw, barcode, context.config.timeZone ?? DEFAULT_ZONE, (value) => {
            context.reportUnknown("status_text", value);
          });
    }),
});
