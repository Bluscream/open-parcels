import { z } from "zod";
import {
  defineCarrier,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";
import { asObject, CARRIER_ID, orderSnapshot, type Json } from "./parse.js";

const HOST = "www.sypost.net";
const CODE_PATTERN = /^[A-Z0-9]{8,30}$/i;

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;
const secretSchema = z.null();

/** Strips the JSONP wrapper by position: the payload itself ends in a nested object. */
function unwrap(body: string): unknown {
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  if (open < 0 || close <= open) {
    throw new UnexpectedResponseError("SunYou did not answer with its callback wrapper.");
  }
  try {
    return JSON.parse(body.slice(open + 1, close));
  } catch {
    throw new UnexpectedResponseError("SunYou answered with unreadable JSON.");
  }
}

/** Returns `data[0]`, or null when SunYou says it has nothing (`has: false`). */
async function lookUp(http: PluginHttp, code: string): Promise<Json | null> {
  const url = new URL(`https://${HOST}/queryTrack`);
  url.searchParams.set("trackNumber", code);
  url.searchParams.set("toLanguage", "en_US");
  const response = await http.request(url);
  if (response.status !== 200) {
    throw new TransientError(`SunYou answered HTTP ${response.status}.`);
  }
  const data = asObject(unwrap(response.body))["data"];
  const first: unknown = Array.isArray(data) ? data[0] : undefined;
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new UnexpectedResponseError("SunYou answered without a data entry.");
  }
  const parcel = first as Json;
  return parcel["has"] === true ? parcel : null;
}

async function track(context: PluginContext<Config, null>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  // No batching: a comma-separated list comes back as one unknown code.
  for (const barcode of barcodes) {
    if (!CODE_PATTERN.test(barcode)) {
      continue;
    }
    const raw = await lookUp(context.http, barcode);
    if (raw !== null) {
      snapshots.push(orderSnapshot(raw, barcode, report));
    }
  }
  return { snapshots, complete: true };
}

export const sunyou = defineCarrier<Config, null>({
  id: CARRIER_ID,
  name: "SunYou",
  countries: ["*"],
  sourceKinds: ["tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "none" },
  http: {
    limits: {
      [HOST]: { intervalMs: 6_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  track,
});
