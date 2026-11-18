import {
  snapshot,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
  type SnapshotEvent,
} from "../../plugin/api.js";
import { GATEWAY_BATCH, GATEWAY_URL, publicTrackingUrl } from "./constants.js";
import { mapDhl } from "./status.js";
import { toIso } from "./time.js";
import { asObjects, asString, parseJson, type Json } from "./util.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

/**
 * The keyless DHL Parcel gateway. One request answers a comma-separated batch; codes it does
 * not know are simply missing, so answers are matched on their `barcode`, never on position.
 */
export async function fetchGateway(
  deps: Deps,
  codes: readonly string[],
): Promise<Map<string, Json>> {
  const found = new Map<string, Json>();
  for (let start = 0; start < codes.length; start += GATEWAY_BATCH) {
    const batch = codes.slice(start, start + GATEWAY_BATCH);
    const url = new URL(GATEWAY_URL);
    url.searchParams.set("key", batch.join(","));
    const response = await deps.http.request(url, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      // Plain text, not JSON: none of the batch is known.
      continue;
    }
    if (response.status !== 200) {
      throw new TransientError(`The DHL gateway answered HTTP ${response.status}.`);
    }
    const body = parseJson(response.body);
    if (!Array.isArray(body)) {
      throw new UnexpectedResponseError("The DHL gateway did not answer with a list.");
    }
    for (const item of asObjects(body)) {
      const barcode = asString(item["barcode"]);
      if (barcode !== null) {
        found.set(barcode.toUpperCase(), item);
      }
    }
  }
  return found;
}

/** The fine `status` wins over the coarse `category`; the category alone cannot say "pickup". */
function mapEvent(deps: Deps, event: Json): SnapshotEvent["status"] {
  const status = asString(event["status"]);
  const category = asString(event["category"]);
  const fine = status === null ? null : mapDhl({ code: status });
  if (status !== null && fine === null) {
    // Reported even when the category still maps: the fine value belongs in the shared table.
    deps.reportUnknown("gateway_status", status);
  }
  const mapped = fine ?? (category === null ? null : mapDhl({ code: category }));
  if (mapped === null && category !== null) {
    deps.reportUnknown("gateway_category", category);
  }
  return mapped?.status ?? null;
}

export function normalizeGateway(deps: Deps, code: string, raw: Json): ParcelSnapshot {
  // Oldest first on this backend.
  const events = asObjects(raw["events"]);
  const history: SnapshotEvent[] = [];
  for (const event of events) {
    const at = toIso(event["timestamp"], null);
    if (at !== null) {
      history.push({
        at,
        status: mapEvent(deps, event),
        rawStatus: asString(event["status"]) ?? asString(event["category"]) ?? "",
        location: null,
      });
    }
  }
  const last = events.at(-1);
  const deliveredAt = toIso(raw["deliveredAt"], null);
  const latest = last === undefined ? null : mapEvent(deps, last);
  // A return that reached the sender also carries `deliveredAt`; the event says which it was.
  const status = deliveredAt !== null && latest === null ? "delivered" : latest;
  const delivered = status === "delivered";
  const pickup = status === "at_pickup_point";
  return snapshot({
    carrier: "dhl",
    barcode: code,
    status,
    rawStatus: last === undefined ? null : (asString(last["status"]) ?? asString(last["category"])),
    delivered,
    deliveredAt: delivered ? deliveredAt : null,
    plannedFrom: delivered ? null : toIso(last?.["momentIndication"], null),
    pickup,
    url: publicTrackingUrl(code),
    history,
    raw,
  });
}
