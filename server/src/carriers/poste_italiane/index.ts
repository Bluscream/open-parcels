import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  isoTime,
  objects,
  readObject,
  snapshot,
  text as kitText,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";
import { estimateDay, isPickupSentence, sentenceStatus } from "./status.js";

/** Poste Italiane's fields are strings; a number in one is not taken as text. */
const text = (value: unknown): string | null => kitText(value, { numbers: false });

export const CARRIER_ID = "poste_italiane";
const ZONE = "Europe/Rome";
const HOST = "www.poste.it";
const API = new URL(`https://${HOST}/online/dovequando/DQ-REST/ricercasemplice`);
const BARCODE = carrierPattern("poste_italiane");

const configSchema = z.object({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

/** Returns the record, or null when Poste does not know the code (also true before the first scan). */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const response = await http.request(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: `https://${HOST}`,
      referer: `https://${HOST}/`,
    },
    body: JSON.stringify({ codiceSpedizione: barcode, tipoRichiedente: "WEB", periodoRicerca: 1 }),
  });
  if (response.status !== 200) {
    throw new TransientError(`Poste Italiane answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "Poste Italiane");
  const outcome = payload["esitoRicerca"];
  if (outcome === "3" && text(payload["idTracciatura"]) !== null) {
    return payload;
  }
  if (outcome === "1" || outcome === "2") {
    return null;
  }
  throw new UnexpectedResponseError("Poste Italiane answered with an unknown envelope.");
}

/** The collection point named on the newest event whose own wording says it is collectable. */
function pickupPoint(events: readonly Json[]): string | null {
  for (const event of events) {
    if (!isPickupSentence(text(event["statoLavorazione"]))) {
      continue;
    }
    const name = text(event["denominazioneUfficio"]);
    if (name !== null) {
      const address = text(event["indirizzoUfficio"]);
      return address === null ? name : `${name}, ${address}`;
    }
    const place = text(event["luogo"]);
    // `luogo` on other events may be the recipient's own address, so only an office is read.
    if (place?.toUpperCase().startsWith("UFFICIO POSTALE") === true) {
      return place;
    }
  }
  return null;
}

function toSnapshot(raw: Json, barcode: string, report: (text: string) => void): ParcelSnapshot {
  const events = objects(raw["listaMovimenti"])
    .map((event) => ({ event, at: isoTime(event["dataOra"], { naive: "utc", epoch: "ms" }) }))
    .filter((entry): entry is { event: Json; at: string } => entry.at !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const history: SnapshotEvent[] = [];
  for (const { event, at } of events) {
    const sentence = text(event["statoLavorazione"]);
    if (sentence !== null) {
      history.push({ at, status: sentenceStatus(sentence), rawStatus: sentence, location: null });
    }
  }
  const latest = history[0];
  if (latest?.status === null) {
    report(latest.rawStatus);
  }
  // The newest event that maps decides; `stato` 5 is Poste's own "delivered" flag.
  let status = history.find((entry) => entry.status !== null)?.status ?? null;
  if (String(raw["stato"]) === "5") {
    status = "delivered";
  }
  const delivered = status === "delivered";
  const day = delivered ? null : estimateDay(text(raw["dataPrevistaConsegna"]));
  const code = text(raw["idTracciatura"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: latest?.rawStatus ?? text(raw["stato"]),
    delivered,
    deliveredAt: delivered
      ? (history.find((entry) => entry.status === "delivered")?.at ?? null)
      : null,
    plannedFrom: day === null ? null : isoTime(`${day}T00:00:00`, { naive: { zone: ZONE } }),
    plannedTo: day === null ? null : isoTime(`${day}T23:59:59`, { naive: { zone: ZONE } }),
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(events.map((entry) => entry.event)),
    url: rulesTrackingUrl(CARRIER_ID, code),
    history,
    raw,
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (sentence: string): void => {
    context.reportUnknown("status_text", sentence);
  };
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(toSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

/** Poste Italiane: the public "Dove e quando" tracking. */
export const posteItaliane = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Poste Italiane",
  countries: ["IT"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 5_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
