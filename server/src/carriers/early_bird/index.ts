import { z } from "zod";
import {
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

/**
 * Early Bird has no status codes, only sentences in English or Swedish. Each is recognised by
 * how it starts; a sentence that names a city or a time still begins the same way.
 */
const STEMS: readonly (readonly [ParcelStatus | null, readonly string[]])[] = [
  [
    "registered",
    [
      "your delivery is booked with early bird",
      "din leverans är bokad med early bird",
      "leveransen till dig är bokad av e-handlaren",
    ],
  ],
  [
    "in_transit",
    [
      "early bird has received your package",
      "early bird har tagit emot ditt paket",
      "your package has arrived at the terminal in",
      "ditt paket har kommit till terminalen i",
      "paketet har ankommit till sorteringsterminal",
      "your package is on its way. you will receive a notification",
      "paketet är på väg. du får ett meddelande",
      "since we were unable to deliver the parcel to your home",
      "eftersom vi inte kunde leverera paketet hem",
    ],
  ],
  [
    "problem",
    [
      "we failed to deliver your package",
      "vi misslyckades med att leverera",
      "we were unable to access the entrance",
      "vi kunde inte komma in i porten",
    ],
  ],
  [
    "at_pickup_point",
    [
      "your package is now ready for collection from the parcel locker",
      "ditt paket finns nu redo att hämtas",
    ],
  ],
  [
    "delivered",
    [
      "the package has been collected from the parcel locker",
      "paketet har hämtats ur paketskåpet",
      "the package has been delivered",
      "ditt paket har nu levererats",
    ],
  ],
  // Known, but says nothing new: the status before it still holds.
  [null, ["we have scheduled a new attempt", "vi har bokat in ett nytt försök"]],
];

/** Texts that put the parcel in a locker at some point, even when the status says otherwise. */
const LOCKER_MARKERS = [
  "parcel locker",
  "paketskåp",
  "since we were unable to deliver the parcel to your home",
  "eftersom vi inte kunde leverera paketet hem",
  "ditt paket finns nu redo att hämtas",
];

const PLAUSIBLE = /^[A-Z0-9-]{6,40}$/;

const clean = (value: unknown): string => text(value)?.replace(/\s+/g, " ") ?? "";

/** `known` is false for a sentence we have never seen; `status` is null for one that adds nothing. */
function classify(sentence: string): { known: boolean; status: ParcelStatus | null } {
  const lowered = sentence.toLowerCase();
  for (const [status, stems] of STEMS) {
    if (stems.some((stem) => lowered.startsWith(stem))) {
      return { known: true, status };
    }
  }
  return { known: false, status: null };
}

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
    pickup:
      status === "at_pickup_point" ||
      lowered.some((sentence) => LOCKER_MARKERS.some((marker) => sentence.includes(marker))),
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
