import { z } from "zod";
import {
  carrierPattern,
  defineCarrier,
  snapshot,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
  type PluginHttp,
  asObject,
  num,
  objects,
  readObject,
  text,
  type Json,
  isoTime,
  newestFirst,
  zonedIso,
  expectStatus,
  trackEach,
  unknownReporter,
  type ParcelStatus,
} from "../../plugin/api.js";

const CARRIER_ID = "dynalogic";
const HOST = "api.dynagroup.nl";
const ZONE = "Europe/Amsterdam";

const configSchema = z.object({
  /** Orders are looked up by order number and the recipient's postcode, e.g. `1234AB`. */
  postalCode: z
    .string()
    .transform((value) => value.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(/^[1-9]\d{3}([A-Z]{2})?$/)),
});
type Config = z.infer<typeof configSchema>;

/** Job types: delivery, neighbour, pickup, swap, return, drop-off and correction, each `_DEF`/`_FAIL`. */
const SCENARIOS = new Set(
  ["DEL", "PU", "SW", "RS", "DP", "COR"].flatMap((job) => [`${job}_DEF`, `${job}_FAIL`]),
);
SCENARIOS.add("DEL_NB");
const FIRST_STEP = 1;
const LAST_STEP = 4;
/** The result code of a completed order. */
const COMPLETE = 0;
/** Result codes seen on real orders; others are reported so they can be named. */
const KNOWN_RESULTS = new Set([0, 1, 3, 9, 11, 14, 22, 25, 27, 32, 52, 73, 76, 78, 79, 86]);
const ACTIVITY_TEXT_KEYS = ["Description", "ActivityDescription", "Text", "Name", "Status"];
const ADDRESSEE_NAME_KEYS = ["Name1", "Company", "Name", "FullName", "CompanyName"];

const PLAUSIBLE = carrierPattern("dynalogic");

/**
 * Dynalogic has no status field; the scenario (job type plus outcome), the active step of a
 * four-step ladder and the result code together describe where the order is.
 */
function statusOf(
  scenario: string | null,
  step: number | null,
  code: number | null,
): ParcelStatus | null {
  if (scenario?.endsWith("_FAIL") === true) {
    return "problem";
  }
  if (scenario === "RS_DEF") {
    return "returning";
  }
  if (code === COMPLETE && step === LAST_STEP) {
    return "delivered";
  }
  if (step === null) {
    return null;
  }
  if (step >= 3) {
    return "out_for_delivery";
  }
  return step === 2 ? "in_transit" : "registered";
}

/** `20261118093000` (local Dutch time) or ISO 8601. */
function timestamp(value: unknown): string | null {
  const raw = text(value);
  const compact = raw === null ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (compact === null) {
    return isoTime(raw, { naive: { zone: ZONE }, epoch: "auto", epochStrings: true });
  }
  const n = (index: number): number => Number(compact[index]);
  return zonedIso(
    { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) },
    ZONE,
  );
}

async function lookUp(http: PluginHttp, code: string, postalCode: string): Promise<Json | null> {
  const url = new URL(
    `https://${HOST}/track-middleware/v1/transportorder/full/ordernumber/${encodeURIComponent(code)}/zipcode/${encodeURIComponent(postalCode.toLowerCase())}`,
  );
  const response = await http.request(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  expectStatus(response, "Dynalogic tracking");
  return readObject(response, "Dynalogic tracking");
}

function history(order: Json): SnapshotEvent[] {
  const events: SnapshotEvent[] = [];
  for (const activity of objects(order["Activities"])) {
    const at = timestamp(activity["ExecutedDateTime"]);
    const rawStatus =
      ACTIVITY_TEXT_KEYS.map((key) => text(activity[key])).find((value) => value !== null) ?? null;
    // An activity is free text with no canonical meaning, so it never carries a status.
    if (at !== null && rawStatus !== null) {
      events.push({ at, rawStatus, status: null, location: null });
    }
  }
  return newestFirst(events);
}

function receiver(order: Json): string | null {
  const addressee = order["Addressee"];
  if (typeof addressee === "string") {
    return text(addressee);
  }
  const block = asObject(addressee);
  return ADDRESSEE_NAME_KEYS.map((key) => text(block[key])).find((name) => name !== null) ?? null;
}

function toSnapshot(raw: Json, barcode: string, report: (key: string) => void): ParcelSnapshot {
  const rawScenario = text(raw["Scenario"])?.toUpperCase() ?? null;
  const scenario = rawScenario !== null && SCENARIOS.has(rawScenario) ? rawScenario : null;
  const rawStep = num(raw["ActiveStep"]);
  const step = rawStep !== null && rawStep >= FIRST_STEP && rawStep <= LAST_STEP ? rawStep : null;
  const code = num(raw["TransportResultCode"]);
  if (rawScenario !== null && scenario === null) {
    report(`scenario:${rawScenario}`);
  }
  if (rawStep !== null && step === null) {
    report(`step:${String(rawStep)}`);
  }
  if (code !== null && !KNOWN_RESULTS.has(code)) {
    report(`result:${String(code)}`);
  }
  const status = scenario === null && step === null ? null : statusOf(scenario, step, code);
  const parts = [raw["Scenario"], raw["ActiveStep"], raw["TransportResultCode"]].map(
    (part) => text(part) ?? "?",
  );
  const order = asObject(raw["OrderData"]);
  const events = history(order);
  const delivered = status === "delivered";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: parts.every((part) => part === "?") ? null : parts.join("/"),
    deliveredAt: delivered ? (events[0]?.at ?? null) : null,
    sender: text(order["CustomerName"]),
    receiver: receiver(order),
    history: events,
    raw,
  });
}

async function track(context: PluginContext<Config, unknown>, barcodes: readonly string[]) {
  const report = unknownReporter(context, "status");
  return trackEach(barcodes, { plausible: PLAUSIBLE }, async (code, tracked) => {
    const raw = await lookUp(context.http, code, context.config.postalCode);
    return raw === null ? null : toSnapshot(raw, tracked, report);
  });
}

/** Dynalogic (Netherlands, Belgium): heavy and two-person deliveries, tracked by order number. */
export const dynalogic = defineCarrier<Config, unknown>({
  id: CARRIER_ID,
  name: "Dynalogic",
  countries: ["NL", "BE"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema: z.unknown(),
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 5_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
