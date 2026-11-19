import { z } from "zod";
import {
  asTracked,
  carrierPattern,
  defineCarrier,
  unknownReporter,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { DE_IDENTITY_HOST, DE_PARCEL_HOST, deSnapshot, GlsGermany } from "./de.js";
import { ES_HOST, esSnapshot, lookUpEs } from "./es.js";
import { groupSnapshot, lookUpGroup } from "./group.js";
import { CA_HOST, caSnapshot, lookUpCa, lookUpUs, US_HOST, usSnapshot } from "./na.js";
import { lookUpNl, nlSnapshot } from "./nl.js";
import { lookUpPl, PL_HOST, plSnapshot } from "./pl.js";
import { CARRIER_ID, COUNTRIES, GROUP_COUNTRIES, NL_HOST, type NationalCountry } from "./shared.js";

/** GLS parcel numbers: digits, or short letter-and-digit references. Anything else is never sent. */
const BARCODE_PATTERN = carrierPattern("gls");

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

/**
 * Every GLS lookup is keyed on the delivery country and, for history, the delivery postcode, so
 * a tracking source covers parcels delivered to one address. Poland and the US never send it.
 */
const configSchema = z.looseObject({
  country: z.enum(COUNTRIES),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 -]{3,10}$/),
});
type Config = z.infer<typeof configSchema>;

const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

type Report = (code: string) => void;
type Lookup = (barcode: string) => Promise<ParcelSnapshot | null>;

function nationalLookup(
  context: PluginContext<Config, Secret>,
  country: NationalCountry,
  report: Report,
  germany: () => GlsGermany,
): Lookup {
  const { http, logger, clock } = context;
  const postcode = context.config.postalCode;
  switch (country) {
    case "NL":
      return async (code) => {
        const raw = await lookUpNl(http, code, postcode);
        return raw === null ? null : nlSnapshot(raw, code, postcode, report);
      };
    case "DE":
      return async (code) => {
        const raw = await germany().parcel(code, postcode);
        return raw === null ? null : deSnapshot(raw, code, report);
      };
    case "ES":
    case "PT":
      return async (code) => {
        const raw = await lookUpEs(http, logger, clock.now(), code, postcode);
        return raw === null ? null : esSnapshot(raw, { barcode: code, postcode, country }, report);
      };
    case "PL":
      return async (code) => {
        const raw = await lookUpPl(http, code);
        return raw === null ? null : plSnapshot(raw, code, report);
      };
    case "US":
      return async (code) => {
        const raw = await lookUpUs(http, code);
        return raw === null ? null : usSnapshot(raw, code, report);
      };
    case "CA":
      return async (code) => {
        const raw = await lookUpCa(http, code, postcode);
        return raw === null ? null : caSnapshot(raw, code, report);
      };
  }
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const { country, postalCode } = context.config;
  const report = unknownReporter(context, "status_code", { once: false });
  let germany: GlsGermany | null = null;
  const openGermany = (): GlsGermany => {
    germany ??= new GlsGermany(
      context.http,
      context.logger,
      () => context.clock.now().getTime(),
      context.session.load(),
    );
    return germany;
  };
  const group = GROUP_COUNTRIES[country];
  const lookUp: Lookup =
    group === undefined
      ? nationalLookup(context, country as NationalCountry, report, openGermany)
      : async (code) => {
          const millis = context.clock.now().getTime();
          const raw = await lookUpGroup(context.http, millis, group, code, postalCode);
          return raw === null ? null : groupSnapshot(raw, code, group, report);
        };
  const snapshots: ParcelSnapshot[] = [];
  try {
    // One at a time: the host limiter paces them, and an error stops the run before more go out.
    for (const barcode of barcodes) {
      if (!isPlausibleBarcode(barcode)) {
        continue;
      }
      const found = await lookUp(barcode);
      if (found !== null) {
        // GLS answers with its own parcel number in some networks; the tracked code stays the key.
        snapshots.push(asTracked(found, barcode));
      }
    }
  } finally {
    await (germany as GlsGermany | null)?.save(context.session);
  }
  return { snapshots, complete: true };
}

const paced = { intervalMs: 5_000, burst: 2 };

export const gls = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "GLS",
  countries: [...COUNTRIES],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [NL_HOST]: paced,
      "gls-group.com": paced,
      "gls-group.eu": paced,
      [DE_IDENTITY_HOST]: { intervalMs: 30_000, burst: 1 },
      [DE_PARCEL_HOST]: paced,
      [ES_HOST]: paced,
      [PL_HOST]: paced,
      [US_HOST]: paced,
      [CA_HOST]: paced,
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
