import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  asObject,
  num,
  objects,
  text,
  type Json,
  epoch,
  isoTime,
  newestFirst,
  ruleStatus,
  trackEach,
  unknownReporter,
  rulesTrackingUrl,
} from "../../plugin/api.js";
import { FedExSession, HOST } from "./api.js";

const CARRIER_ID = "fedex";
const POUND_KG = 0.45359237;

/** The user's own FedEx developer API key (client id and secret), stored encrypted. */
const secretSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
type Secret = z.infer<typeof secretSchema>;

const PLAUSIBLE = carrierPattern("fedex");

function place(location: unknown): string | null {
  const block = asObject(location);
  const parts = [block["city"], block["stateOrProvinceCode"], block["countryCode"]]
    .map((part) => text(part))
    .filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

function history(raw: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const event of objects(raw["scanEvents"])) {
    const at = isoTime(event["date"], { naive: "reject", epoch: "auto", epochStrings: true });
    const code = text(event["eventType"]) ?? text(event["derivedStatusCode"]);
    const rawStatus = text(event["eventDescription"]) ?? code;
    if (at !== null && rawStatus !== null) {
      events.push({
        at,
        rawStatus,
        status: ruleStatus(CARRIER_ID, code),
        location: place(event["scanLocation"]),
      });
    }
  }
  return newestFirst(events);
}

function weightKg(raw: Json): number | null {
  const weights = objects(
    asObject(asObject(raw["packageDetails"])["weightAndDimensions"])["weight"],
  );
  const kg = num(weights.find((weight) => weight["unit"] === "KG")?.["value"]);
  const lb = num(weights.find((weight) => weight["unit"] === "LB")?.["value"]);
  return kg ?? (lb === null ? null : Math.round(lb * POUND_KG * 1000) / 1000);
}

function deliveredAt(raw: Json): string | null {
  const actual = asObject(raw["deliveryDetails"])["actualDeliveryTimestamp"];
  const dated = objects(raw["dateAndTimes"]).find((entry) => entry["type"] === "ACTUAL_DELIVERY");
  return (
    isoTime(actual, { naive: "reject", epoch: "auto", epochStrings: true }) ??
    isoTime(dated?.["dateTime"], { naive: "reject", epoch: "auto", epochStrings: true })
  );
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const latest = asObject(raw["latestStatusDetail"]);
  const code = text(latest["code"]) ?? text(latest["derivedCode"]);
  const status = ruleStatus(CARRIER_ID, code);
  if (code !== null && status === null) {
    report(code);
  }
  const delivered = status === "delivered";
  const window = asObject(asObject(raw["estimatedDeliveryTimeWindow"])["window"]);
  const from = isoTime(window["begins"], { naive: "reject", epoch: "auto", epochStrings: true });
  const to = isoTime(window["ends"], { naive: "reject", epoch: "auto", epochStrings: true });
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: text(latest["statusByLocale"]) ?? text(latest["description"]) ?? code,
    deliveredAt: delivered ? deliveredAt(raw) : null,
    plannedFrom: delivered ? null : from,
    plannedTo: delivered || epoch(to) === epoch(from) ? null : to,
    pickup: status === "at_pickup_point",
    pickupPoint: status === "at_pickup_point" ? place(latest["scanLocation"]) : null,
    url:
      rulesTrackingUrl(CARRIER_ID, barcode) ??
      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(barcode)}`,
    weightKg: weightKg(raw),
    history: history(raw),
    raw,
  });
}

async function track(context: PluginContext<unknown, Secret>, barcodes: readonly string[]) {
  const session = new FedExSession(context, context.secret);
  const report = unknownReporter(context, "status_code");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await session.track(code);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** FedEx: the official Track API, with the user's own developer API key. */
export const fedex = defineCarrier<unknown, Secret>({
  id: CARRIER_ID,
  name: "FedEx",
  countries: ["*"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({}),
  secretSchema,
  signIn: { type: "api_key" },
  // The free API tier allows far more; a household never needs it.
  http: {
    limits: { [HOST]: { intervalMs: 3_000, burst: 3 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
