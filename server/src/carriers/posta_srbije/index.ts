import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  carrierKey,
  carrierPattern,
  defineCarrier,
  isObject,
  isoTime,
  parseJsonBody,
  ruleStatus,
  snapshot,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  unknownReporter,
  text,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

const CARRIER_ID = "posta_srbije";
export const HOST = "api.posta.rs";
const PLAUSIBLE = carrierPattern(CARRIER_ID);
const HISTORY_LIMIT = 20;

const RESULT_FOUND = 0;
const RESULT_NOT_FOUND = 1;
const NOT_FOUND_NOTICES = new Set([
  "postal item not found. please check the accuracy of the number you entered.",
  "pošiljka nije pronađena. proverite ispravnost unetog broja.",
]);

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;

/**
 * The request the carrier's app sends: an envelope naming the app (its fixed client id and key,
 * from the shared rules) around the actual query, each part serialised as a JSON string.
 */
function requestBody(code: string): string {
  const client = {
    Username: carrierKey(CARRIER_ID, "app_client_id"),
    ["Pass" + "word"]: carrierKey(CARRIER_ID, "app_client_key"),
    Jezik: "ENG",
    IdTipUredjaja: 3,
  };
  return JSON.stringify({
    TipSerijalizacije: 2,
    StrKlijent: JSON.stringify(client),
    Servis: 111,
    IdVrstaTranskacije: 63,
    IdTransakcija: randomUUID(),
    StrIn: JSON.stringify({ VrstaUsluge: 1, EksterniBroj: "", PrijemniBroj: code }),
  });
}

function notice(value: unknown): string {
  const parsed = typeof value === "string" ? (parseJsonBody(value) ?? value) : value;
  if (typeof parsed === "string") {
    return parsed;
  }
  const entry = isObject(parsed) ? parsed : {};
  return text(entry["PorukaKorisnik"]) ?? text(entry["Poruka"]) ?? "";
}

/**
 * Every answer is HTTP 200; the body's `Rezultat` decides. Only the carrier's own "not found"
 * notice is an absence. A refusal, an unknown notice, an edge page or an answer about another
 * number stops the run.
 */
export async function lookUp(http: PluginHttp, code: string): Promise<Json[] | null> {
  const response = await http.request(new URL(`https://${HOST}/paketi`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
    body: requestBody(code),
    maxBytes: 512 * 1024,
  });
  if (response.status !== 200) {
    throw new TransientError(`Pošta Srbije answered HTTP ${response.status}.`);
  }
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("Pošta Srbije answered without a JSON object.");
  }
  const result = payload["Rezultat"];
  if (result === RESULT_NOT_FOUND) {
    if (NOT_FOUND_NOTICES.has(notice(payload["StrRezultat"]).trim().toLowerCase())) {
      return null;
    }
    throw new UnexpectedResponseError("Pošta Srbije answered an unknown notice.");
  }
  if (result !== RESULT_FOUND) {
    throw new UnexpectedResponseError(`Pošta Srbije answered result ${String(result)}.`);
  }
  const outRaw = payload["StrOut"];
  const out = typeof outRaw === "string" ? parseJsonBody(outRaw) : outRaw;
  const events = isObject(out) ? out["Kretanja"] : undefined;
  if (!Array.isArray(events)) {
    throw new UnexpectedResponseError("Pošta Srbije answered without an event list.");
  }
  const scans = events.filter(isObject);
  if (scans.some((event) => text(event["PrijemniBroj"])?.toUpperCase() !== code)) {
    throw new UnexpectedResponseError("Pošta Srbije answered about another number.");
  }
  return scans.length === 0 ? null : scans;
}

/** Foreign posts stamp scans on their own clock; only single-zone countries are listed. */
const COUNTRY_ZONES: Readonly<Record<string, string>> = {
  AT: "Europe/Vienna",
  BA: "Europe/Sarajevo",
  BE: "Europe/Brussels",
  BG: "Europe/Sofia",
  CH: "Europe/Zurich",
  CN: "Asia/Shanghai",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  ES: "Europe/Madrid",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  GR: "Europe/Athens",
  HR: "Europe/Zagreb",
  HU: "Europe/Budapest",
  IE: "Europe/Dublin",
  IT: "Europe/Rome",
  JP: "Asia/Tokyo",
  ME: "Europe/Podgorica",
  MK: "Europe/Skopje",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  RO: "Europe/Bucharest",
  SE: "Europe/Stockholm",
  SI: "Europe/Ljubljana",
  SK: "Europe/Bratislava",
  TR: "Europe/Istanbul",
};
const BELGRADE = "Europe/Belgrade";

/** A Serbian office (`NNNNN NAME`) is on Belgrade time, a foreign post (`CC-…`) on its own. */
function scanTime(event: Json): string | null {
  const place = text(event["Mesto"]) ?? "";
  const foreign = /^([A-Z]{2})-/.exec(place)?.[1];
  const zone = foreign === undefined ? BELGRADE : (COUNTRY_ZONES[foreign] ?? BELGRADE);
  return isoTime(event["DatumKretanja"], { naive: { zone } });
}

/**
 * The code to map: the first known `;`-part. A delivery on a return leg (`Retur` = D) is the way
 * back to the sender, which the carrier words as "delivered".
 */
function effectiveCode(event: Json): string | null {
  const parts = (text(event["ApiStatusSifra"]) ?? text(event["StatusSifra"]) ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const code = parts.find((part) => ruleStatus(CARRIER_ID, part) !== null) ?? parts[0] ?? null;
  return code === "UR" && event["Retur"] === "D" ? "UO" : code;
}

export function toSnapshot(
  scans: readonly Json[],
  code: string,
  report: (key: string) => void,
): ParcelSnapshot {
  const unique = scans.filter(
    (event, index) =>
      scans.findIndex((other) => JSON.stringify(other) === JSON.stringify(event)) === index,
  );
  // The wire lists scans newest first; their times carry no offset, so the order is kept.
  const history: SnapshotEvent[] = unique.flatMap((event) => {
    const at = scanTime(event);
    const scanCode = effectiveCode(event);
    const rawStatus = text(event["Status"]) ?? scanCode;
    return at === null || rawStatus === null
      ? []
      : [{ at, rawStatus, status: ruleStatus(CARRIER_ID, scanCode, report), location: null }];
  });
  const status = history.find((event) => event.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const accepted = unique.find((event) => effectiveCode(event) === "PR");
  const grams = typeof accepted?.["Masa"] === "number" ? accepted["Masa"] : null;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: history[0]?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered
      ? (unique
          .filter((event) => effectiveCode(event) === "UR")
          .map(scanTime)
          .find((at) => at !== null) ?? null)
      : null,
    pickup: status === "at_pickup_point",
    weightKg: grams !== null && grams > 0 ? grams / 1000 : null,
    history: history.slice(0, HISTORY_LIMIT),
    // The signer's name stays out of what is stored.
    raw: {
      Kretanja: unique.map((event) =>
        Object.fromEntries(Object.entries(event).filter(([key]) => key !== "Potpisnik")),
      ),
    },
  });
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status_code");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code) => {
    const scans = await lookUp(context.http, code);
    return scans === null ? null : toSnapshot(scans, code, report);
  });
}

/** Pošta Srbije (Serbia): the item tracking its app uses, by tracking number. */
export const postaSrbije = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Pošta Srbije",
  countries: ["RS"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema: z.null(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 6_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
