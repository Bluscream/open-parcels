import {
  asArray as asList,
  asObject,
  isObject,
  isoTime,
  parseJsonBody,
  ruleFieldsStatus,
  snapshot,
  TransientError,
  UnexpectedResponseError,
  text,
  type CookieJar,
  type HttpResponse,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
} from "../../../plugin/api.js";
import { solveAltcha } from "./altcha.js";

export const PL_HOST = "mojdhl.pl";
export const PL_API = `https://${PL_HOST}/api/dhl/public`;
/** The public lookup's validator refuses anything shorter. */
export const MIN_CODE_LENGTH = 11;

export interface PlRequest {
  readonly method?: "GET" | "POST";
  readonly body?: Json;
  readonly headers?: Readonly<Record<string, string>>;
  readonly jar?: CookieJar;
  readonly query?: Readonly<Record<string, string>>;
}

export async function plCall(
  http: PluginHttp,
  path: string,
  request: PlRequest = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${PL_API}${path}`);
  url.search = new URLSearchParams(request.query ?? {}).toString();
  const response: HttpResponse = await http.request(url, {
    method: request.method ?? "GET",
    headers: {
      accept: "application/json",
      "accept-language": "pl-PL",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...request.headers,
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    ...(request.jar === undefined ? {} : { jar: request.jar }),
  });
  return { status: response.status, body: parseJsonBody(response.body) };
}

/** A fresh, solved challenge: each one is single-use. */
export async function captcha(http: PluginHttp, jar?: CookieJar): Promise<string> {
  const { status, body } = await plCall(
    http,
    "/auth/captcha/challenge",
    jar === undefined ? {} : { jar },
  );
  if (status !== 200 || !isObject(body)) {
    throw new TransientError(`Mój DHL's challenge answered HTTP ${status}.`);
  }
  return await solveAltcha(body);
}

async function postStatus(http: PluginHttp, codes: readonly string[]) {
  const body: Record<string, string> = Object.fromEntries(
    codes.map((code, index) => [`number${String(index + 1)}`, code]),
  );
  body["captcha-payload"] = await captcha(http);
  return plCall(http, "/shipment/status", { method: "POST", body });
}

function rejected(codes: readonly string[], body: unknown): Set<string> {
  const errors = asObject(asObject(body)["errors"]);
  return new Set(
    Object.keys(errors)
      .map((key) => /^number(\d+)$/.exec(key)?.[1])
      .map((index) => (index === undefined ? undefined : codes[Number(index) - 1]))
      .filter((code): code is string => code !== undefined),
  );
}

/**
 * The public lookup: one batch for every code, behind one solved challenge. A number the
 * validator refuses fails the batch with a 422 naming it; the batch is sent once more without it.
 */
export async function lookUpPublic(
  http: PluginHttp,
  keys: readonly string[],
): Promise<Map<string, Json>> {
  let codes = keys.filter((code) => code.length >= MIN_CODE_LENGTH);
  const found = new Map<string, Json>();
  if (codes.length === 0) {
    return found;
  }
  let answer = await postStatus(http, codes);
  if (answer.status === 422) {
    const refused = rejected(codes, answer.body);
    codes = codes.filter((code) => !refused.has(code));
    if (refused.size === 0 || codes.length === 0) {
      return found;
    }
    answer = await postStatus(http, codes);
  }
  if (answer.status !== 200) {
    throw new TransientError(`Mój DHL's lookup answered HTTP ${answer.status}.`);
  }
  if (!Array.isArray(answer.body)) {
    throw new UnexpectedResponseError("Mój DHL's lookup answered without a list.");
  }
  for (const item of answer.body.filter(isObject)) {
    const number = text(item["number"]);
    const shipment = asList(item["shipments"]).find(isObject);
    if (number !== null && codes.includes(number) && shipment !== undefined) {
      found.set(number, shipment);
    }
  }
  return found;
}

/**
 * The raw `TT_*`/`SP_*` code first; the timeline step only for a code the table does not know.
 * Both are namespaced fields in the shared DHL table.
 */
export function plStatus(
  raw: string | null,
  step: string | null,
  report: (key: string) => void,
): ParcelSnapshot["status"] {
  const byCode = raw === null ? null : ruleFieldsStatus("dhl", { pl_status: raw });
  if (raw !== null && byCode === null) {
    report(raw);
  }
  return byCode ?? (step === null ? null : ruleFieldsStatus("dhl", { pl_step: step }));
}

const utc = (value: unknown): string | null => isoTime(value, { naive: "utc" });

/** One public-lookup shipment; it carries no event log. */
export function publicSnapshot(
  code: string,
  raw: Json,
  report: (key: string) => void,
): ParcelSnapshot {
  const status = plStatus(text(raw["status"]), text(raw["timelineStep"]), report);
  const delivered = status === "delivered";
  return snapshot({
    carrier: "dhl",
    barcode: text(raw["shipmentNumber"]) ?? code,
    status,
    rawStatus: text(raw["step"]) ?? text(raw["status"]),
    delivered,
    deliveredAt: delivered ? (utc(raw["receiptDateUtc"]) ?? utc(raw["deliveryDateUtc"])) : null,
    plannedFrom: delivered ? null : utc(raw["planOfDeliveryFromUtc"]),
    plannedTo: delivered ? null : utc(raw["planOfDeliveryToUtc"]),
    pickup: status === "at_pickup_point",
    sender: text(raw["sender"]),
    raw: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "shipmentPin")),
  });
}
