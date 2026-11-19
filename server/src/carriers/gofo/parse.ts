import {
  isObject,
  isoTime as kitIsoTime,
  newestFirst,
  num,
  objects,
  ruleStatus,
  rulesTrackingUrl,
  snapshot,
  text,
  zonedIso,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "gofo";
/** Transport A answers in this zone's wall-clock time but always stamps a fixed -07:00. */
export const WALL_CLOCK_ZONE = "America/Los_Angeles";

/** Parses a timestamp; with `wallClock`, the stamped offset is dropped and the zone's applies. */
export function isoTime(value: unknown, wallClock: boolean): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!wallClock) {
    return kitIsoTime(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"), {
      naive: { zone: "America/Los_Angeles" },
    });
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (match === null) {
    return null;
  }
  const n = (index: number): number => Number(match[index] ?? "0");
  return zonedIso(
    { year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5), second: n(6) },
    WALL_CLOCK_ZONE,
  );
}

function events(raw: Json): Json[] {
  return objects(raw["trackEventList"]);
}

function mapCode(code: string | null): ParcelStatus | null {
  return code === null ? null : ruleStatus(CARRIER_ID, `process:${code}`);
}

function resolve(
  raw: Json,
  report: (code: string) => void,
): { status: ParcelStatus | null; rawStatus: string | null } {
  const last = isObject(raw["lastTrackEvent"]) ? raw["lastTrackEvent"] : (events(raw)[0] ?? {});
  const code = text(last["processCode"]);
  const mapped = mapCode(code);
  if (mapped !== null) {
    return { status: mapped, rawStatus: text(last["processContent"]) ?? code };
  }
  if (code !== null) {
    report(code);
  }
  const itemStatus = text(raw["status"]);
  const fallback = itemStatus === null ? null : ruleStatus(CARRIER_ID, `item:${itemStatus}`);
  if (itemStatus !== null && fallback === null) {
    report(`status:${itemStatus}`);
  }
  return { status: fallback, rawStatus: itemStatus ?? code };
}

export function publicUrl(barcode: string): string | null {
  return rulesTrackingUrl(CARRIER_ID, barcode);
}

/** One result item as a snapshot. No delivery window: those fields have never been seen filled. */
export function toSnapshot(
  raw: Json,
  barcode: string,
  options: { readonly wallClock: boolean; readonly report: (code: string) => void },
): ParcelSnapshot {
  const { status, rawStatus } = resolve(raw, options.report);
  const delivered = status === "delivered";
  const history: SnapshotEvent[] = [];
  for (const event of events(raw)) {
    const at = isoTime(event["processDate"], options.wallClock);
    const code = text(event["processCode"]);
    const label = text(event["processContent"]) ?? code;
    if (at !== null && label !== null) {
      history.push({ at, rawStatus: label, status: mapCode(code), location: null });
    }
  }

  const deliveryEvent =
    events(raw).find((e) => text(e["processCode"]) === "205") ??
    (isObject(raw["lastTrackEvent"]) ? raw["lastTrackEvent"] : {});
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered ? isoTime(deliveryEvent["processDate"], options.wallClock) : null,
    pickup: status === "at_pickup_point",
    url: publicUrl(barcode),
    weightKg: num(raw["weight"]),
    history: newestFirst(history),
    raw,
  });
}
