import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  defineCarrier,
  snapshot,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import {
  asObject,
  dig,
  isObject,
  isoTime,
  joinParts,
  mapLocal,
  requestJson,
  statusReporter,
  text,
  trackOneByOne,
  type Json,
  type ParcelStatus,
} from "../_kit/json.js";

const CARRIER_ID = "budbee";
const HOST = "tracking.budbee.com";
const API = `https://${HOST}/api`;
const PLAUSIBLE = /^[A-Z0-9-]{6,40}$/i;

/** Door deliveries. "ReturnedToTerminal" is arrival at a terminal, forward progress. */
const DELIVERY_STATUS: Readonly<Record<string, ParcelStatus>> = {
  NotStarted: "registered",
  OnRouteCollection: "in_transit",
  Collected: "in_transit",
  CollectedShippingLabel: "in_transit",
  CrossDocked: "in_transit",
  OnRouteDelivery: "out_for_delivery",
  Delivered: "delivered",
  Miss: "problem",
  Backordered: "problem",
  ReturnedToTerminal: "in_transit",
  ReturnedToMerchant: "returning",
};

/** Locker orders: "Delivered" means waiting in the locker; "PickedUp" is the hand-over. */
const BOX_STATUS: Readonly<Record<string, ParcelStatus>> = {
  NotStarted: "registered",
  Pending: "registered",
  Collected: "in_transit",
  CollectedShippingLabel: "in_transit",
  DroppedOff: "in_transit",
  Delivered: "at_pickup_point",
  PickedUp: "delivered",
  Undelivered: "problem",
  ReturnedToTerminal: "in_transit",
  ReturnedToMerchant: "returning",
};

const OUTGOING_TYPES = new Set(["RETURN", "ON_DEMAND_PICKUP"]);

/** An order never changes type, so the routing call runs once per code while the server lives. */
const META_CACHE_LIMIT = 500;
const metaCache = new Map<string, Json>();

/** The `/v3` routes answer 200 with the failure in the body. Null means "unknown code". */
function unwrap(body: unknown): Json | null {
  if (!isObject(body)) {
    throw new UnexpectedResponseError("Budbee did not answer with an object.");
  }
  const error = text(body["errorCode"]);
  if (error === "ORDER_NOT_FOUND") {
    return null;
  }
  if (error !== null || body["status"] === "FAILED") {
    throw new UnexpectedResponseError(`Budbee refused the lookup (${error ?? "FAILED"}).`);
  }
  const payload = body["payload"];
  return isObject(payload) ? payload : null;
}

async function readMeta(http: PluginHttp, code: string): Promise<Json | null> {
  const cached = metaCache.get(code);
  if (cached !== undefined) {
    return cached;
  }
  const url = new URL(`${API}/v3/orders/${encodeURIComponent(code)}/meta`);
  const meta = unwrap(await requestJson(http, url, "Budbee routing"));
  if (meta !== null) {
    if (metaCache.size >= META_CACHE_LIMIT) {
      metaCache.clear();
    }
    metaCache.set(code, meta);
  }
  return meta;
}

async function readBox(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`${API}/box/${encodeURIComponent(code)}`);
  const body = await requestJson(http, url, "Budbee locker", { notFound: [404] });
  if (body === null) {
    return null;
  }
  if (!isObject(body)) {
    throw new UnexpectedResponseError("Budbee locker order is not an object.");
  }
  return body;
}

async function readDelivery(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`${API}/v3/orders/${encodeURIComponent(code)}`);
  const payload = unwrap(await requestJson(http, url, "Budbee order"));
  if (payload === null) {
    return null;
  }
  const conspectus = payload["conspectus"];
  return isObject(conspectus) ? conspectus : payload;
}

/** Reads one parcel: the routing call decides the route and the status vocabulary. */
export async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const meta = await readMeta(http, code);
  if (meta === null) {
    return null;
  }
  const type = text(meta["type"]);
  let payload: Json | null;
  if (type === "BOX") {
    payload = await readBox(http, code);
  } else if (type === "DELIVERY") {
    payload = await readDelivery(http, code);
  } else {
    payload = (await readBox(http, code)) ?? (await readDelivery(http, code));
  }
  return payload === null ? null : { ...payload, meta };
}

/** Budbee masks the recipient's own details with asterisks; those read as "not known". */
function unmasked(value: unknown): string | null {
  const raw = text(value);
  return raw === null || /^\*+$/.test(raw) ? null : raw;
}

function orderType(raw: Json): "BOX" | "DELIVERY" {
  const reported = text(dig(raw, "meta", "type"));
  if (reported === "BOX" || reported === "DELIVERY") {
    return reported;
  }
  return isObject(raw["status"]) ? "DELIVERY" : "BOX";
}

function lockerName(raw: Json): string | null {
  for (const address of [raw["lockerAddress"], dig(raw, "lockerAttributes", "address")]) {
    if (!isObject(address)) {
      continue;
    }
    const name = unmasked(address["name"]);
    const place = joinParts(unmasked(address["street"]), unmasked(address["city"]));
    if (name !== null || place !== null) {
      return name ?? place;
    }
  }
  return null;
}

/** Budbee returns no event list on either route, so history stays empty rather than invented. */
export function toSnapshot(raw: Json, code: string, report: (c: string) => void): ParcelSnapshot {
  const type = orderType(raw);
  const statusBlock = asObject(raw["status"]);
  const rawStatus = type === "DELIVERY" ? text(statusBlock["state"]) : text(raw["status"]);
  const status = mapLocal(type === "BOX" ? BOX_STATUS : DELIVERY_STATUS, rawStatus, (c) => {
    report(`${type}:${c}`);
  });
  const delivered = status === "delivered";
  let plannedFrom: string | null = null;
  let plannedTo: string | null;
  if (type === "BOX") {
    plannedTo = isoTime(raw["eta"] ?? dig(raw, "etaInformation", "eta"));
  } else {
    plannedFrom = isoTime(dig(raw, "consignment", "start"));
    plannedTo = isoTime(dig(raw, "consignment", "stop"));
    if (plannedTo === plannedFrom) {
      plannedTo = null;
    }
  }
  const outgoing =
    OUTGOING_TYPES.has(text(dig(raw, "consignment", "type")) ?? "") ||
    rawStatus === "CollectedShippingLabel";
  const barcode = text(raw["token"]) ?? code;
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    direction: outgoing ? "outgoing" : "incoming",
    status,
    rawStatus,
    delivered,
    deliveredAt: delivered
      ? isoTime(type === "BOX" ? raw["deliveredAt"] : statusBlock["date"])
      : null,
    plannedFrom: delivered ? null : plannedFrom,
    plannedTo: delivered ? null : plannedTo,
    pickup: status === "at_pickup_point",
    pickupPoint: lockerName(raw),
    url: `https://track.budbee.com/${encodeURIComponent(barcode)}`,
    sender: unmasked(dig(raw, "merchant", "name")),
    receiver: unmasked(dig(raw, "consumer", "name")),
    raw,
  });
}

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();
type Secret = z.infer<typeof secretSchema>;

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const report = statusReporter(context);
  return trackOneByOne(barcodes, PLAUSIBLE, async (code) => {
    const raw = await lookUp(context.http, code);
    return raw === null ? null : toSnapshot(raw, code, report);
  });
}

export const budbee = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Budbee",
  countries: ["SE", "NL", "BE", "DK", "FI"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: { [HOST]: { intervalMs: 4_000, burst: 2 }, "*": { intervalMs: 10_000, burst: 1 } },
  },
  track,
});
