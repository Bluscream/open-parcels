import { z } from "zod";
import {
  carrierPattern,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type FetchResult,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { mapDpd, publicUrl, textStatus, trackingStepStatus, type ParcelStatus } from "./status.js";
import { localTimestamp } from "./time.js";

export const TRACKING_HOST = "tracking.dpd.de";
export const trackingApiUrl = (barcode: string): URL =>
  new URL(`https://${TRACKING_HOST}/rest/plc/de_DE/${encodeURIComponent(barcode)}`);

/** DPD parcel numbers are 14 digits; anything else is not looked up on the public page. */
const BARCODE = carrierPattern("dpd");

const contentSchema = z.object({ content: z.array(z.string()).optional() }).loose();
const statusInfoSchema = z
  .object({
    status: z.string(),
    statusHasBeenReached: z.boolean().optional(),
    isCurrentStatus: z.boolean().optional(),
    description: contentSchema.nullish(),
  })
  .loose();
const scanSchema = z
  .object({
    date: z.string(),
    scanData: z
      .object({
        location: z.string().nullish(),
        scanType: z.object({ code: z.string().nullish() }).loose().nullish(),
      })
      .loose()
      .nullish(),
    scanDescription: contentSchema.nullish(),
  })
  .loose();
const responseSchema = z
  .object({
    parcellifecycleResponse: z
      .object({
        parcelLifeCycleData: z
          .object({
            statusInfo: z.array(statusInfoSchema).nullish(),
            scanInfo: z
              .object({ scan: z.array(scanSchema).nullish() })
              .loose()
              .nullish(),
          })
          .loose()
          .nullish(),
      })
      .loose(),
  })
  .loose();
type LifeCycle = NonNullable<
  z.infer<typeof responseSchema>["parcellifecycleResponse"]["parcelLifeCycleData"]
>;

const firstLine = (value: { content?: string[] | undefined } | null | undefined): string =>
  value?.content?.find((line) => line.trim() !== "")?.trim() ?? "";

type Report = (kind: string, key: string) => void;

function scanEvent(scan: z.infer<typeof scanSchema>, report: Report): SnapshotEvent | null {
  const at = localTimestamp(scan.date);
  if (at === null) {
    report("scan_date_shape", scan.date.replace(/\d/g, "0"));
    return null;
  }
  const code = scan.scanData?.scanType?.code ?? "";
  const text = firstLine(scan.scanDescription);
  const status = (code === "" ? null : mapDpd({ code })?.status) ?? textStatus(text);
  if (status === null && code !== "") {
    report("scan_code", code);
  }
  return {
    at,
    status,
    rawStatus: text === "" ? code : text,
    location: scan.scanData?.location?.trim() ?? null,
  };
}

function lifeCycleSnapshot(barcode: string, data: LifeCycle, report: Report): ParcelSnapshot {
  const steps = data.statusInfo ?? [];
  const current =
    steps.find((step) => step.isCurrentStatus === true) ??
    steps.filter((step) => step.statusHasBeenReached === true).at(-1);
  let status: ParcelStatus | null = null;
  if (current !== undefined) {
    status = trackingStepStatus(current.status);
    if (status === null) {
      report("tracking_step", current.status);
    }
  }
  const history = (data.scanInfo?.scan ?? [])
    .map((scan) => scanEvent(scan, report))
    .filter((event): event is SnapshotEvent => event !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestText = history.at(-1)?.rawStatus ?? null;
  // A return that reached the sender still ends on "delivered"; the scans tell it apart.
  if (history.some((event) => event.status === "returning")) {
    status = "returning";
  }
  const delivered = status === "delivered";
  return snapshot({
    carrier: "dpd",
    barcode,
    status,
    rawStatus: current === undefined ? latestText : current.status,
    delivered,
    deliveredAt: delivered
      ? (history.findLast((event) => event.status === "delivered")?.at ?? null)
      : null,
    pickup: status === "at_pickup_point",
    url: publicUrl(barcode),
    history,
    raw: { statusInfo: steps.map((step) => ({ ...step })) },
  });
}

/** Key names only (never values), so a changed response can be recognised from the log. */
function topKeys(body: unknown): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Array.isArray(body) ? "(an array)" : `(a ${typeof body})`;
  }
  const keys = Object.keys(body).slice(0, 8);
  return keys.length === 0 ? "(none)" : keys.join(", ");
}

type TrackingContext = PluginContext<{ publicTracking: boolean }, unknown>;

/** Looks codes up on DPD Germany's public tracking page, one request per code. */
export async function trackDe(
  context: TrackingContext,
  barcodes: readonly string[],
): Promise<FetchResult> {
  if (!context.config.publicTracking) {
    return { snapshots: [], complete: false };
  }
  const report: Report = (kind, key) => {
    context.reportUnknown(kind, key);
  };
  const snapshots: ParcelSnapshot[] = [];
  for (const barcode of barcodes.filter((code) => BARCODE.test(code))) {
    const response = await context.http.request(trackingApiUrl(barcode), {
      headers: { accept: "application/json", "accept-language": "de-DE,de;q=0.9" },
    });
    if (response.status === 404) {
      continue;
    }
    // Messages name the status, the content type and the schema path that broke, never the
    // code or any value from the body; they end up in the source's detail and the log.
    const type = (response.headers.get("content-type") ?? "none").split(";")[0]?.trim();
    if (response.status !== 200) {
      throw new TransientError(
        `DPD tracking answered HTTP ${String(response.status)} (${type ?? "none"}), expected 200 or 404.`,
      );
    }
    let body: unknown;
    try {
      body = response.json();
    } catch {
      throw new UnexpectedResponseError(
        `DPD tracking answered HTTP 200 with ${type ?? "none"} that is not JSON` +
          ` (${String(response.body.length)} bytes${/<html/i.test(response.body) ? ", an HTML page" : ""}).`,
      );
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      const where = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ");
      throw new UnexpectedResponseError(
        `DPD tracking returned JSON of an unexpected shape (${where}); top-level keys: ${topKeys(body)}.`,
      );
    }
    const data = parsed.data.parcellifecycleResponse.parcelLifeCycleData;
    if (data === null || data === undefined) {
      continue;
    }
    snapshots.push(lifeCycleSnapshot(barcode, data, report));
  }
  return { snapshots, complete: true };
}
