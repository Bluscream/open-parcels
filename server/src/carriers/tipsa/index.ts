import { z } from "zod";
import type { PluginHttp } from "../../plugin/api.js";
import {
  ruleStatus,
  CaptchaError,
  defineCarrier,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { carrierPattern, expectStatus } from "../../plugin/api.js";
import { foldWording } from "./page.js";
import { refreshTarget } from "./html.js";
import { madridTime, readPage, type TipsaPage } from "./page.js";

const CARRIER_ID = "tipsa";
const LOOKUP_HOST = "aplicaciones.tip-sa.com";
const DETAIL_HOST = "dinapaqweb.tipsa-dinapaq.com";
const DETAIL_PATH = "/dinapaqweb/detalle_envio.php";

type Status = NonNullable<ParcelSnapshot["status"]>;

/**
 * Status wordings, folded (upper case, no accents). A missort is in transit by decision: TIPSA
 * draws it as a normal step and such parcels go on to be delivered. From the shared table, which
 * also matches wordings followed by an agency, hub, point or reason.
 */
export function mapWording(value: string | null): Status | null {
  if (value === null) {
    return null;
  }
  const folded = foldWording(value);
  return ruleStatus(CARRIER_ID, folded);
}

const BARCODE_PATTERN = carrierPattern("tipsa");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_DATE = /^\d{2}\/\d{2}\/\d{2}$/;
/** Markers unique to a bot-check interstitial (normal pages carry a harmless script too). */
const CHALLENGE_MARKERS = ["<title>Just a moment", "cf-browser-verification", "cf_chl_opt"];

const configSchema = z.looseObject({
  /** The delivery postcode. TIPSA only shows a shipment together with it. */
  postalCode: z.string().min(1),
});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

/** Validates the lookup's refresh target. Null means TIPSA does not know the code and postcode. */
function detailUrl(target: string | null): URL | null {
  let url: URL;
  try {
    url = new URL(target ?? "");
  } catch {
    throw new UnexpectedResponseError("TIPSA lookup answered without a usable detail address.");
  }
  const names = [...url.searchParams.keys()].sort();
  if (
    url.origin !== `https://${DETAIL_HOST}` ||
    url.pathname !== DETAIL_PATH ||
    url.hash !== "" ||
    names.join(",") !== "fecha,servicio"
  ) {
    throw new UnexpectedResponseError("TIPSA lookup pointed to an unexpected address.");
  }
  const service = url.searchParams.get("servicio") ?? "";
  const date = url.searchParams.get("fecha") ?? "";
  if (service === "" && date === "") {
    return null;
  }
  if (!UUID.test(service) || !SHORT_DATE.test(date)) {
    throw new UnexpectedResponseError("TIPSA lookup parameters have an unexpected shape.");
  }
  return url;
}

/**
 * Two GETs: the postcode-gated lookup, which answers with the detail address in a meta refresh,
 * then the detail page. The postcode-free route is never used, not even as a fallback.
 */
async function lookUp(
  http: PluginHttp,
  barcode: string,
  postcode: string,
): Promise<TipsaPage | null> {
  const lookup = new URL(`https://${LOOKUP_HOST}/cliente/datos_prestashop.php`);
  lookup.searchParams.set("id", barcode);
  lookup.searchParams.set("cp", postcode);
  const headers = { "accept-language": "es-ES,es;q=0.9" };
  const door = await http.request(lookup, { headers, redirect: "manual" });
  expectStatus(door, "TIPSA", 200);
  if (door.body.includes("No ha proporcionado el CP") || door.body.includes("Error en el CP")) {
    throw new TransientError("TIPSA did not accept the configured postcode.");
  }
  const url = detailUrl(refreshTarget(door.body));
  if (url === null) {
    return null;
  }
  // The detail page declares no charset; it is Latin-1.
  const detail = await http.request(url, { headers, redirect: "manual", encoding: "latin1" });
  expectStatus(detail, "TIPSA", 200);
  if (CHALLENGE_MARKERS.some((marker) => detail.body.includes(marker))) {
    throw new CaptchaError("TIPSA served a bot check instead of the shipment page.");
  }
  return readPage(detail.body, barcode);
}

function number(value: string | undefined): number | null {
  const parsed = Number((value ?? "").replace(",", "."));
  return value === undefined || value === "" || Number.isNaN(parsed) ? null : parsed;
}

export function tipsaSnapshot(
  page: TipsaPage,
  barcode: string,
  report: (wording: string) => void,
): ParcelSnapshot {
  const history = page.events.map((event) => ({
    at: event.at,
    status: mapWording(event.status),
    rawStatus: event.status ?? "",
    location: event.location,
  }));
  const current = mapWording(page.status);
  if (page.status !== null && current === null) {
    report(foldWording(page.status).slice(0, 80));
  }
  // The page's own status, else the newest history row that maps.
  const status = current ?? history.find((event) => event.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const deliveredRow = history.find((event) => event.status === "delivered");
  const fields = page.fields;
  const sender = fields["sender"];
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: page.status,
    delivered,
    // The history row is on Madrid time like every row; the delivery block is the depot's local time.
    deliveredAt: delivered
      ? (deliveredRow?.at ??
        madridTime(fields["deliveredDate"] ?? "", fields["deliveredTime"] ?? ""))
      : null,
    pickup: status === "at_pickup_point",
    // A masked name is noise.
    sender: sender === undefined || sender === "" || sender.includes("*") ? null : sender,
    weightKg: number(fields["weightKg"]),
    history: history.filter((event) => event.rawStatus !== ""),
    raw: { status: page.status, fields, events: page.events },
  });
}

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const postcode = context.config.postalCode.replace(/\s+/g, "").toUpperCase();
  const snapshots: ParcelSnapshot[] = [];
  const report = (wording: string): void => {
    context.reportUnknown("status_text", wording);
  };
  for (const barcode of barcodes) {
    if (!BARCODE_PATTERN.test(barcode)) {
      continue;
    }
    const page = await lookUp(context.http, barcode, postcode);
    if (page !== null) {
      snapshots.push(tipsaSnapshot(page, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const tipsa = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "TIPSA",
  countries: ["ES", "PT", "AD"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [LOOKUP_HOST]: { intervalMs: 8_000, burst: 1 },
      [DETAIL_HOST]: { intervalMs: 8_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
