import { z } from "zod";
import {
  carrierPattern,
  type PluginHttp,
  asArray,
  defineCarrier,
  isObject,
  isoTime,
  newestFirst,
  readObject,
  ruleStatus,
  snapshot,
  text,
  trackEach,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginContext,
  type SnapshotEvent,
  rulesTrackingUrl,
} from "../../plugin/api.js";

const CARRIER_ID = "box_now";
const PLAUSIBLE = carrierPattern("box_now");

const COUNTRIES = {
  // `locale` picks the country's tracking page in the shared rules.
  gr: { tld: "gr", locale: "el", zone: "Europe/Athens" },
  bg: { tld: "bg", locale: "bg", zone: "Europe/Sofia" },
  hr: { tld: "hr", locale: "hr", zone: "Europe/Zagreb" },
  cy: { tld: "cy", locale: "el-CY", zone: "Asia/Nicosia" },
} as const;
type Country = keyof typeof COUNTRIES;
const apiHost = (country: Country): string => `api-production.boxnow.${COUNTRIES[country].tld}`;

/** The parcel's own `state` and each event's `type`, from the shared table. */
const stateStatus = (state: string): ParcelStatus | null =>
  ruleStatus(CARRIER_ID, `state:${state}`);
const eventStatus = (type: string): ParcelStatus | null => ruleStatus(CARRIER_ID, `event:${type}`);

/** One request per code. No matching parcel shows as a missing or empty `data` list. */
async function lookUp(http: PluginHttp, country: Country, barcode: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${apiHost(country)}/api/v1/parcels:track`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parcelId: barcode }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new TransientError(`BOX NOW tracking answered HTTP ${response.status}.`);
  }
  const first = asArray(readObject(response, "BOX NOW tracking")["data"])[0];
  if (first === undefined) {
    return null;
  }
  if (!isObject(first)) {
    throw new UnexpectedResponseError("BOX NOW tracking listed something that is not a parcel.");
  }
  return first;
}

interface Dated {
  readonly at: string;
  readonly event: Json;
}

export function boxNowSnapshot(
  raw: Json,
  barcode: string,
  country: Country,
  report: (key: string) => void,
): ParcelSnapshot {
  const { zone, locale } = COUNTRIES[country];
  const dated: Dated[] = asArray(raw["events"])
    .filter(isObject)
    .flatMap((event) => {
      const at = isoTime(event["createTime"], { naive: { zone } });
      return at === null ? [] : [{ at, event }];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const newest = dated[0];
  const state = text(raw["state"]);
  const newestType = newest === undefined ? null : text(newest.event["type"]);
  const status =
    (state === null ? null : stateStatus(state)) ??
    (newestType === null ? null : eventStatus(newestType));
  if (state !== null && status === null) {
    report(`state:${state}`);
  }
  const history: SnapshotEvent[] = dated.flatMap(({ at, event }) => {
    const type = text(event["type"]);
    if (type === null) {
      return [];
    }
    const mapped = eventStatus(type);
    if (mapped === null) {
      report(`event:${type}`);
    }
    return [
      {
        at,
        rawStatus: type,
        status: mapped,
        location: text(event["locationDisplayName"]),
      },
    ];
  });
  const delivered = status === "delivered";
  const pickup = status === "at_pickup_point";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: state ?? newestType,
    delivered,
    deliveredAt: delivered ? (newest?.at ?? null) : null,
    pickup,
    pickupPoint: pickup && newest !== undefined ? text(newest.event["locationDisplayName"]) : null,
    url: rulesTrackingUrl(CARRIER_ID, barcode, locale),
    history: newestFirst(history),
    // Only what the mapping needs: the answer also carries payment and service details.
    raw: {
      id: raw["id"] ?? null,
      state,
      events: dated.map(({ event }) => ({
        createTime: event["createTime"] ?? null,
        type: event["type"] ?? null,
        postalCode: event["postalCode"] ?? null,
        locationDisplayName: event["locationDisplayName"] ?? null,
      })),
    },
  });
}

const configSchema = z.looseObject({
  country: z
    .enum(["gr", "bg", "hr", "cy"])
    .default("gr")
    .describe("The BOX NOW country the parcels are sent in."),
});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

const LIMIT = { intervalMs: 5_000, burst: 2 } as const;

export const boxNow = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "BOX NOW",
  countries: ["GR", "BG", "HR", "CY"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [apiHost("gr")]: LIMIT,
      [apiHost("bg")]: LIMIT,
      [apiHost("hr")]: LIMIT,
      [apiHost("cy")]: LIMIT,
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, context.config.country, barcode);
      return raw === null
        ? null
        : boxNowSnapshot(raw, barcode, context.config.country, (key) => {
            context.reportUnknown("status_code", key);
          });
    }),
});
