import {
  asObject,
  isObject,
  text as kitText,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type Json,
  type PluginHttp,
} from "../../plugin/api.js";

export const API_HOST = "moja.posta.si";
export const AUTH_HOST = "auth.posta.si";
export const API_BASE = `https://${API_HOST}/api/v1/parcels`;

/** The service's fields are strings; a number in one is not taken as text. */
export const text = (value: unknown): string | null => kitText(value, { numbers: false });

const BLOCK_PAGE =
  /Just a moment|Access Denied|Attention Required|cf-turnstile|_cf_chl_opt|Azure Front Door|Request blocked/i;

export interface Answer {
  readonly status: number;
  readonly payload: Json | null;
}

/**
 * GET without following redirects. A block page or the service's own client guard stops the
 * run: neither says anything about a parcel. Everything else is the caller's to read.
 */
export async function getJson(
  http: PluginHttp,
  url: URL,
  headers: Readonly<Record<string, string>> = {},
): Promise<Answer> {
  const response = await http.request(url, {
    redirect: "manual",
    headers: { accept: "application/json", ...headers },
  });
  return classify(response);
}

function classify(response: HttpResponse): Answer {
  if (response.status >= 300 && response.status < 400) {
    throw new UnexpectedResponseError(`Pošta Slovenije redirected (HTTP ${response.status}).`);
  }
  let payload: unknown = null;
  try {
    payload = response.json();
  } catch {
    if (BLOCK_PAGE.test(response.body.slice(0, 4096))) {
      throw new TransientError(
        `Pošta Slovenije answered with a block page (HTTP ${response.status}).`,
      );
    }
  }
  const json = isObject(payload) ? payload : null;
  if (response.status === 403 && text(json?.["errorCode"]) === "error.not.allowed") {
    throw new TransientError("Pošta Slovenije refused this client (error.not.allowed).");
  }
  return { status: response.status, payload: json };
}

/** The `result` of a 200 envelope; anything else stops the run. */
export function resultOf(answer: Answer): Json {
  if (answer.status !== 200) {
    throw new TransientError(`Pošta Slovenije answered HTTP ${answer.status}.`);
  }
  const result = answer.payload?.["result"];
  if (answer.payload === null || text(answer.payload["errorCode"]) !== null || !isObject(result)) {
    throw new UnexpectedResponseError("Pošta Slovenije answered with an unexpected envelope.");
  }
  return result;
}

export const parcelOf = (result: Json): Json => asObject(result["parcel"]);
