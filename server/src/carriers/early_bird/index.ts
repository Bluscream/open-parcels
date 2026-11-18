import { z } from "zod";
import {
  carrierPattern,
  CaptchaError,
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type PluginHttp,
  asObject,
  isObject,
  objects,
  readObject,
  rulesStatus,
  text,
  type Json,
  isoTime,
  expectStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
} from "../../plugin/api.js";

const CARRIER_ID = "early_bird";
const HOST = "earlybird.se";
const ZONE = "Europe/Stockholm";
/** Longest unknown text reported; event texts are sentences, the opening identifies them. */
const REPORT_LENGTH = 80;

const PLAUSIBLE = carrierPattern("early_bird");

const clean = (value: unknown): string => text(value)?.replace(/\s+/g, " ") ?? "";

/**
 * Early Bird has no status codes, only sentences in English or Swedish, which the shared table
 * recognises by how they start. `known` is false for a sentence we have never seen; `status` is
 * null for one that adds nothing (the table maps those to unknown).
 */
function classify(sentence: string): { known: boolean; status: ParcelStatus | null } {
  const hit = rulesStatus(CARRIER_ID, { text: sentence.toLowerCase(), fields: { use: "status" } });
  return hit === null
    ? { known: false, status: null }
    : { known: true, status: hit.status === "unknown" ? null : hit.status };
}

/** Whether a text puts the parcel in a locker at some point, even when its status says otherwise. */
const mentionsLocker = (lowered: string): boolean =>
  rulesStatus(CARRIER_ID, { text: lowered, fields: { use: "locker" } }) !== null;

async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/api/tracking`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ trackingNumber: code, locale: "en" }),
  });
  if (response.headers.get("x-vercel-mitigated") !== null) {
    throw new CaptchaError("Early Bird put a browser challenge in front of the tracking.");
  }
  const payload = readObject(response, "Early Bird tracking");
  const errorCode = payload["code"];
  if (
    (response.status === 404 && errorCode === "tracking_not_found") ||
    (response.status === 400 && errorCode === "invalid_tracking_number")
  ) {
    return null;
  }
  expectStatus(response, "Early Bird tracking");
  if (payload["type"] !== "timeline" && payload["type"] !== "external_link") {
    throw new UnexpectedResponseError("Early Bird answered with an unknown reply type.");
  }
  return payload;
}

/** The timeline is newest first; a reply without one carries only its headline status. */
function timeline(raw: Json): Json[] {
  const events = objects(raw["events"]);
  return events.length > 0 || !isObject(raw["status"]) ? events : [raw["status"]];
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const result: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["occurredAt"], {
      naive: { zone: ZONE },
      epoch: "auto",
      epochStrings: true,
    });
    const rawStatus = clean(event["text"]);
    if (at !== null && rawStatus !== "") {
      result.push({ at, rawStatus, status: classify(rawStatus).status, location: null });
    }
  }
  return result;
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const events = timeline(raw);
  let status: ParcelStatus | null = null;
  let source: Json | null = null;
  if (raw["type"] === "external_link") {
    // Handed over to another carrier for the last mile; Early Bird has nothing more to say.
    status = "in_transit";
  } else {
    for (const event of events) {
      const sentence = clean(event["text"]);
      const { known, status: mapped } = classify(sentence);
      if (!known && sentence !== "") {
        report(sentence.slice(0, REPORT_LENGTH));
      }
      if (mapped !== null) {
        status = mapped;
        source = event;
        break;
      }
    }
  }
  const lowered = events.map((event) => clean(event["text"]).toLowerCase());
  const headline = text(asObject(raw["status"])["text"]) ?? text(events[0]?.["text"]);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: headline,
    deliveredAt:
      status === "delivered"
        ? isoTime(source?.["occurredAt"], {
            naive: { zone: ZONE },
            epoch: "auto",
            epochStrings: true,
          })
        : null,
    pickup: status === "at_pickup_point" || lowered.some(mentionsLocker),
    url: `https://${HOST}/spara-och-hjalp?id=${encodeURIComponent(barcode)}`,
    history: history(events),
    raw,
  });
}

async function track(context: PluginContext<unknown, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_text");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** Early Bird (Sweden): morning home and locker deliveries, public tracking by code. */
export const earlyBird = defineCarrier<unknown, unknown>({
  id: CARRIER_ID,
  name: "Early Bird",
  countries: ["SE"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
