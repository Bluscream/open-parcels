import {
  carrierPattern,
  loadRules,
  trackingUrl,
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
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  ruleStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { z } from "zod";

const CARRIER_ID = "4px";
const HOST = "track.4px.com";
const PLAUSIBLE = carrierPattern("4px");

/**
 * One code per request. A code 4PX does not know comes back as one item whose `serverCode` and
 * `tracks` are both null; every other unusual envelope is a broken response, not a miss.
 */
async function lookUp(http: PluginHttp, barcode: string): Promise<Json | null> {
  const response = await http.request(new URL(`https://${HOST}/track/v2/front/listTrackV3`), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ queryCodes: [barcode], language: "en-us", translateLanguage: "" }),
  });
  if (response.status !== 200) {
    throw new TransientError(`4PX tracking answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "4PX tracking");
  const data = asArray(payload["data"]);
  const parcel: unknown = data[0];
  if (payload["result"] !== 1 || data.length !== 1 || !isObject(parcel)) {
    throw new UnexpectedResponseError("4PX tracking answered with an unexpected envelope.");
  }
  const absent = (value: unknown): boolean => value === null || value === undefined;
  if (absent(parcel["serverCode"]) && absent(parcel["tracks"])) {
    return null;
  }
  if (text(parcel["serverCode"]) === null || asArray(parcel["tracks"]).length === 0) {
    throw new UnexpectedResponseError("4PX tracking listed a parcel without code or events.");
  }
  return parcel;
}

function history(tracks: readonly unknown[]): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const entry of tracks) {
    const track = asObject(entry);
    // `tkDate` carries an offset; a value without one is skipped rather than guessed.
    const at = isoTime(track["tkDate"], { naive: "reject" });
    const code = text(track["tkCode"]);
    if (at === null || code === null) {
      continue;
    }
    events.push({
      at,
      rawStatus: text(track["tkDesc"]) ?? code,
      status: ruleStatus(CARRIER_ID, code),
      location: text(track["tkLocation"]),
    });
  }
  return newestFirst(events);
}

export function fourPxSnapshot(
  raw: Json,
  barcode: string,
  report: (code: string) => void,
): ParcelSnapshot {
  const tracks = asArray(raw["tracks"]);
  // 4PX lists events newest first.
  const latest = asObject(tracks[0]);
  const code = text(latest["tkCode"]);
  const status = ruleStatus(CARRIER_ID, code);
  for (const entry of tracks) {
    const eventCode = text(asObject(entry)["tkCode"]);
    ruleStatus(CARRIER_ID, eventCode, report);
  }
  const delivered = status === "delivered";
  const resolved = text(raw["serverCode"]) ?? barcode;
  return snapshot({
    carrier: CARRIER_ID,
    barcode: resolved,
    status,
    rawStatus: text(latest["tkDesc"]) ?? code,
    delivered,
    deliveredAt: delivered ? isoTime(latest["tkDate"], { naive: "reject" }) : null,
    url:
      trackingUrl(loadRules(), CARRIER_ID, resolved) ??
      `https://${HOST}/#/result/0/${encodeURIComponent(resolved)}`,
    history: history(tracks),
    raw,
  });
}

const configSchema = z.looseObject({});
const secretSchema = z.null();
type Config = z.infer<typeof configSchema>;

export const fourPx = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "4PX",
  countries: ["*"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track: (context: PluginContext<Config, null>, barcodes) =>
    trackEach(barcodes, PLAUSIBLE, async (barcode) => {
      const raw = await lookUp(context.http, barcode);
      return raw === null
        ? null
        : fourPxSnapshot(raw, barcode, (code) => {
            context.reportUnknown("status_code", code);
          });
    }),
});
