import { z } from "zod";
import {
  type PluginHttp,
  asArray,
  asObject,
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  readObject,
  snapshot,
  text,
  trackEach,
  TransientError,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type StatusTable,
} from "../../plugin/api.js";

const CARRIER_ID = "aramex";
const PLAUSIBLE = /^[A-Z0-9]{6,40}$/i;

const COUNTRIES = {
  AU: { host: "www.aramex.com.au", zone: "Australia/Sydney" },
  NZ: { host: "www.aramex.co.nz", zone: "Pacific/Auckland" },
} as const;
type Country = keyof typeof COUNTRIES;

/** Aramex AU/NZ scan codes. Better to map too little than wrongly; the rest are reported. */
export const ARAMEX_STATUS: StatusTable = {
  PP8: "registered",
  PPP: "in_transit",
  PP1: "in_transit",
  PCY: "in_transit",
  "078": "in_transit",
  RIA: "in_transit",
  B72: "in_transit",
  S2M: "in_transit",
  SYD: "in_transit",
  TOO: "in_transit",
  TRN: "in_transit",
  ONB: "out_for_delivery",
  R36: "delivered",
  YES: "delivered",
  U03: "problem",
  UND: "problem",
  RTS: "returning",
};

/** Display text without control characters or runs of whitespace, capped in length. */
function clean(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const printable = raw.replace(/\p{Cc}/gu, " ");
  return printable.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

async function lookUp(http: PluginHttp, country: Country, barcode: string): Promise<Json | null> {
  const url = new URL(`https://${COUNTRIES[country].host}/umbraco/api/TrackingApi/GetTrackingData`);
  url.searchParams.set("LabelNo", barcode);
  url.searchParams.set("dataFormat", "json");
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw new TransientError(`Aramex tracking answered HTTP ${response.status}.`);
  }
  // An unknown label and one not scanned yet both answer 200 without a scan list.
  const result = readObject(response, "Aramex tracking")["result"];
  return isObject(result) && Array.isArray(result["Scans"]) ? result : null;
}

interface Scan {
  readonly at: string;
  readonly code: string | null;
  readonly label: string | null;
}

function scans(result: Json, zone: string): Scan[] {
  return asArray(result["Scans"]).flatMap((entry) => {
    const scan = asObject(entry);
    const at = isoTime(scan["RealDateTime"] ?? scan["Date"], { naive: { zone } });
    return at === null
      ? []
      : [{ at, code: text(scan["Status"]), label: clean(scan["StatusDescription"]) }];
  });
}

/** `DeliveryETADate` is a booking-time estimate as DD/MM/YYYY: the whole local day. */
function etaWindow(value: unknown, zone: string): { from: string | null; to: string | null } {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(value) ?? "");
  if (match === null) {
    return { from: null, to: null };
  }
  const day = { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
  return {
    from: zonedIso(day, zone),
    to: zonedIso({ ...day, hour: 23, minute: 59, second: 59 }, zone),
  };
}

export function aramexSnapshot(
  result: Json,
  barcode: string,
  country: Country,
  report: (code: string) => void,
): ParcelSnapshot {
  const { zone, host } = COUNTRIES[country];
  const ordered = newestFirst(
    scans(result, zone).map((scan) => ({
      at: scan.at,
      rawStatus: scan.label ?? scan.code ?? "",
      status: scan.code === null ? null : (ARAMEX_STATUS[scan.code] ?? null),
      location: null,
    })),
  );
  const codes = scans(result, zone).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const code of new Set(codes.map((scan) => scan.code))) {
    if (code !== null && ARAMEX_STATUS[code] === undefined) {
      report(code);
    }
  }
  const newest = codes[0];
  const newestCode = newest?.code ?? null;
  const status = newestCode === null ? null : (ARAMEX_STATUS[newestCode] ?? null);
  const delivered = status === "delivered";
  const window = delivered ? { from: null, to: null } : etaWindow(result["DeliveryETADate"], zone);
  const label = text(result["LabelNumber"]) ?? barcode;
  const history: SnapshotEvent[] = ordered.filter((event) => event.rawStatus !== "");
  return snapshot({
    carrier: CARRIER_ID,
    barcode: label,
    status,
    rawStatus: newest?.label ?? newest?.code ?? null,
    delivered,
    deliveredAt: delivered ? (newest?.at ?? null) : null,
    plannedFrom: window.from,
    plannedTo: window.to,
    url: `https://${host}/tools/track?l=${encodeURIComponent(label)}`,
    history,
    // Only what the mapping needs: the full answer carries names and addresses.
    raw: {
      country,
      LabelNumber: label,
      DeliveryETADate: result["DeliveryETADate"] ?? null,
      Scans: codes.map((scan) => ({
        at: scan.at,
        Status: scan.code,
        StatusDescription: scan.label,
      })),
    },
  });
}

const configSchema = z.looseObject({
  country: z.enum(["AU", "NZ"]).default("AU").describe("Aramex Australia or Aramex New Zealand."),
});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

const LIMIT = { intervalMs: 5_000, burst: 2 } as const;

export const aramex = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "Aramex",
  countries: ["AU", "NZ"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [COUNTRIES.AU.host]: LIMIT,
      [COUNTRIES.NZ.host]: LIMIT,
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const result = await lookUp(context.http, context.config.country, barcode);
      return result === null
        ? null
        : aramexSnapshot(result, barcode, context.config.country, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
