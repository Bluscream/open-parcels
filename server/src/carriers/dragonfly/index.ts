import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type PluginHttp,
  asObject,
  isObject,
  ruleStatus,
  objects,
  readObject,
  text,
  type Json,
  epoch,
  isoTime,
  newestFirst,
  expectStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
  rulesTrackingUrl,
} from "../../plugin/api.js";

const CARRIER_ID = "dragonfly";

/**
 * Every country runs the same platform on its own domain; only host, link and language differ.
 * `locale` picks the country's tracking page in the shared rules.
 */
const COUNTRIES = {
  NL: {
    host: "dragonflyshipping.nl",
    locale: "nl",
    languages: ["nl", "en"],
    zone: "Europe/Amsterdam",
  },
  AU: {
    host: "dragonflyshipping.com.au",
    locale: "en-AU",
    languages: ["en"],
    zone: "Australia/Sydney",
  },
  CA: {
    host: "intelcom.ca",
    locale: "en-CA",
    languages: ["en", "fr"],
    zone: "America/Toronto",
  },
} as const;
type Country = (typeof COUNTRIES)[keyof typeof COUNTRIES];

const configSchema = z.object({
  /** The country whose Dragonfly site the parcels are tracked on. */
  country: z.enum(["NL", "AU", "CA"]).default("NL"),
});
type Config = z.infer<typeof configSchema>;

const PLAUSIBLE = carrierPattern("dragonfly");

function stepStatus(step: unknown): ParcelStatus | null {
  if (typeof step !== "number" || !Number.isInteger(step)) {
    return null;
  }
  // A four-step ladder; negative steps are exceptions (the shared table reads both).
  return ruleStatus(CARRIER_ID, `step:${String(step)}`);
}

async function lookUp(http: PluginHttp, country: Country, code: string): Promise<Json | null> {
  const url = new URL(`https://${country.host}/cfworker/v3/tracking/${encodeURIComponent(code)}/`);
  const response = await http.request(url, { headers: { accept: "application/json" } });
  expectStatus(response, "Dragonfly tracking");
  const payload = readObject(response, "Dragonfly tracking");
  const data = asObject(payload["data"]);
  if (payload["success"] === true) {
    const result = data["result"];
    if (!isObject(result)) {
      throw new UnexpectedResponseError("Dragonfly reported success without a parcel.");
    }
    return result;
  }
  if (data["code"] === "not_found") {
    return null;
  }
  throw new UnexpectedResponseError("Dragonfly answered with an unknown error envelope.");
}

/** The status label in the first available language, with link markup and placeholders filled. */
function label(status: Json, languages: readonly string[]): string | null {
  for (const source of [asObject(status["labels"]), status]) {
    const perLanguage = asObject(source["shortLabel"]);
    for (const language of languages) {
      const found = text(perLanguage[language]);
      if (found !== null) {
        const address = asObject(asObject(status["package_location"])["address"]);
        return found
          .replace(/\[link [^\]]*\](.+?)\[\/link\]/gi, "$1")
          .replace(/\{([^{}]+)\}/g, (whole, key: string) => text(address[key]) ?? whole);
      }
    }
  }
  return null;
}

function history(raw: Json, country: Country): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of objects(raw["status_list"])) {
    const at = isoTime(entry["timestamp"], {
      naive: { zone: country.zone },
      epoch: "auto",
      epochStrings: true,
    });
    const rawStatus = label(entry, country.languages) ?? text(entry["step"]);
    if (at !== null && rawStatus !== null) {
      events.push({ at, rawStatus, status: stepStatus(entry["step"]), location: null });
    }
  }
  return newestFirst(events);
}

/** The delivery window: the public estimate, widened by the buffered one; a point has no end. */
function window(raw: Json, zone: string): { from: string | null; to: string | null } {
  const eta = asObject(raw["public_eta"]);
  let from = isoTime(eta["from"] ?? raw["eta"], {
    naive: { zone: zone },
    epoch: "auto",
    epochStrings: true,
  });
  let to = isoTime(raw["live_buffered_eta"] ?? eta["to"] ?? raw["buffered_eta"], {
    naive: { zone: zone },
    epoch: "auto",
    epochStrings: true,
  });
  if (from !== null && to !== null) {
    if (epoch(to) === epoch(from)) {
      to = null;
    } else if (epoch(to) < epoch(from)) {
      [from, to] = [to, from];
    }
  }
  return { from, to };
}

function toSnapshot(
  raw: Json,
  barcode: string,
  country: Country,
  report: (key: string) => void,
): ParcelSnapshot {
  const latest = asObject(raw["last_status"]);
  const step = latest["step"];
  const mapped = stepStatus(step);
  const stepText = text(step);
  if (mapped === null && stepText !== null) {
    report(`step:${stepText}`);
  }
  const delivered = latest["isDelivered"] === true || mapped === "delivered";
  const status = delivered ? "delivered" : mapped;
  const planned = window(raw, country.zone);
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: label(latest, country.languages) ?? stepText,
    delivered,
    deliveredAt: delivered
      ? isoTime(latest["timestamp"], {
          naive: { zone: country.zone },
          epoch: "auto",
          epochStrings: true,
        })
      : null,
    plannedFrom: delivered ? null : planned.from,
    plannedTo: delivered ? null : planned.to,
    pickup: latest["task_type"] === "last_mile_pickup",
    url: rulesTrackingUrl(CARRIER_ID, barcode, country.locale),
    sender: text(raw["client_code"]),
    history: history(raw, country),
    raw,
  });
}

async function track(context: PluginContext<Config, unknown>, barcodes: readonly string[]) {
  const country = COUNTRIES[context.config.country];
  const report = unknownReporter(context, "status");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, country, code);
    return raw === null ? null : toSnapshot(raw, tracked, country, report);
  });
}

const LIMIT = { intervalMs: 5_000, burst: 2 };

/** Dragonfly Shipping and its Canadian sister brand Intelcom: public tracking by code. */
export const dragonfly = defineCarrier<Config, unknown>({
  id: CARRIER_ID,
  name: "Dragonfly",
  countries: ["NL", "AU", "CA"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: {
      [COUNTRIES.NL.host]: LIMIT,
      [COUNTRIES.AU.host]: LIMIT,
      [COUNTRIES.CA.host]: LIMIT,
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
