import { z } from "zod";
import type { PluginHttp } from "../../plugin/api.js";
import {
  carrierPattern,
  ruleStatus,
  defineCarrier,
  SignInRejectedError,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import {
  expectStatus,
  isObject,
  isoTime,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/api.js";

import { emailSignIn, fetchVintedAccount } from "./account.js";

/** Offset-less timestamps are the carrier's local time; numbers are epoch ms. */
const LOCAL_TIME = { naive: { zone: "Europe/Paris" }, epoch: "ms" } as const;

const CARRIER_ID = "vinted_go";
const API_HOST = "carrier.vintedgo.com";

type Status = NonNullable<ParcelSnapshot["status"]>;

const BARCODE_PATTERN = carrierPattern("vinted_go");

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
/** An account source keeps the refresh token from the emailed sign-in link; tracking needs nothing. */
const secretSchema = z.object({ refreshToken: z.string().min(1) }).nullable();
type Secret = z.infer<typeof secretSchema>;

/** The timeline, oldest first; null when Vinted Go does not know the code yet. */
export async function lookUp(http: PluginHttp, barcode: string): Promise<Json[] | null> {
  const url = new URL(
    `https://${API_HOST}/members/public/v1/tracking_events/${encodeURIComponent(barcode)}`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  expectStatus(response, "Vinted Go", 200);
  const payload = readJson(response, "Vinted Go");
  if (!isObject(payload) || !Array.isArray(payload["tracking_events"])) {
    throw new UnexpectedResponseError("Vinted Go answered without a timeline.");
  }
  const events = objects(payload["tracking_events"]);
  return events.length === 0 ? null : events;
}

function mapGroup(group: string | null): Status | null {
  return ruleStatus(CARRIER_ID, group);
}

function history(events: readonly Json[]): SnapshotEvent[] {
  const entries: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["timestamp"], LOCAL_TIME);
    const group = text(event["group"]);
    const rawStatus = text(event["message"]) ?? group;
    if (at !== null && rawStatus !== null) {
      entries.push({ at, status: mapGroup(group), rawStatus, location: null });
    }
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The newest event by time; events without a usable time count as oldest. */
function latest(events: readonly Json[]): Json | undefined {
  const time = (event: Json): number =>
    Date.parse(isoTime(event["timestamp"], LOCAL_TIME) ?? "") || 0;
  return events.reduce<Json | undefined>(
    (best, event) => (best === undefined || time(event) >= time(best) ? event : best),
    undefined,
  );
}

export function vintedSnapshot(
  events: readonly Json[],
  barcode: string,
  report: (group: string) => void,
): ParcelSnapshot {
  const current = latest(events);
  const group = current === undefined ? null : text(current["group"]);
  const status = mapGroup(group);
  if (group !== null && status === null) {
    report(group);
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: current === undefined ? null : (text(current["message"]) ?? group),
    delivered,
    deliveredAt:
      delivered && current !== undefined ? isoTime(current["timestamp"], LOCAL_TIME) : null,
    pickup: status === "at_pickup_point",
    url: `https://vintedgo.com/en/tracking/${encodeURIComponent(barcode)}`,
    history: history(events),
    raw: { tracking_events: events },
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (group: string): void => {
    context.reportUnknown("group", group);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const events = await lookUp(context.http, barcode);
    if (events !== null) {
      snapshots.push(vintedSnapshot(events, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const vintedGo = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Vinted Go",
  countries: ["NL", "BE", "FR"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [emailSignIn<Config>(), { type: "none", kinds: ["tracking"] }],
  http: {
    limits: { [API_HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
  async fetchAccount(context) {
    if (context.secret === null) {
      throw new SignInRejectedError("Sign in to your Vinted Go account first.");
    }
    return fetchVintedAccount(context, context.secret.refreshToken, {
      lookUp,
      toSnapshot: vintedSnapshot,
    });
  },
});
