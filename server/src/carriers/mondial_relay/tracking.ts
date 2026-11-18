import type { PluginHttp } from "../../plugin/http.js";
import {
  CookieJar,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
} from "../../plugin/api.js";
import { API_URL, isObject, PAGE_URL, type Json } from "./shared.js";

/** Shipment numbers are digits; anything else is never sent. */
const BARCODE_PATTERN = /^[0-9]{6,20}$/;
const POSTCODE_PATTERN = /^[A-Z0-9 -]{3,10}$/i;
const TOKEN_PATTERN = /id="tracking"[^>]*\btoken="([^"]+:[^"]+)"/;

export function isPlausibleBarcode(barcode: string): boolean {
  return BARCODE_PATTERN.test(barcode);
}

export function isPlausiblePostcode(postcode: string): boolean {
  return POSTCODE_PATTERN.test(postcode);
}

function checkStatus(response: HttpResponse, what: string): void {
  if (response.status === 403) {
    // A refusal of the client itself, not of one parcel: stop the run instead of retrying each code.
    throw new UnexpectedResponseError(`Mondial Relay refused the ${what} (HTTP 403).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`Mondial Relay ${what} answered HTTP ${response.status}.`);
  }
}

/**
 * One run's lookups. The tracking page sets the cookies and carries the value every lookup in
 * the run sends back, so the page is opened once per run and its cookies stay in this jar.
 */
export class TrackingRun {
  private constructor(
    private readonly http: PluginHttp,
    private readonly jar: CookieJar,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  static async open(http: PluginHttp): Promise<TrackingRun> {
    const jar = new CookieJar();
    const response = await http.request(new URL(PAGE_URL), {
      jar,
      headers: { accept: "text/html" },
    });
    checkStatus(response, "tracking page");
    const token = TOKEN_PATTERN.exec(response.body)?.[1];
    if (token === undefined) {
      throw new UnexpectedResponseError("The Mondial Relay tracking page lacks its request value.");
    }
    return new TrackingRun(http, jar, {
      accept: "application/json",
      referer: PAGE_URL,
      requestverificationtoken: token,
    });
  }

  /**
   * The shipment for code + recipient postcode, or null when there is none. The brand stays empty
   * on purpose: a number is only unique per merchant, and the postcode picks the right parcel.
   */
  async lookUp(barcode: string, postcode: string): Promise<Json | null> {
    const url = new URL(API_URL);
    url.search = new URLSearchParams({
      shipment: barcode,
      postcode,
      brand: "",
      codePays: "",
    }).toString();
    const response = await this.http.request(url, { jar: this.jar, headers: this.headers });
    checkStatus(response, "tracking lookup");
    let body: unknown;
    try {
      body = response.json();
    } catch {
      throw new UnexpectedResponseError("Mondial Relay tracking did not answer with JSON.");
    }
    if (!isObject(body)) {
      throw new UnexpectedResponseError("Mondial Relay tracking did not answer with an object.");
    }
    const expedition = body["Expedition"];
    if (isObject(expedition)) {
      return expedition;
    }
    // "No such parcel" and "invalid request" both answer this way, told apart only by text.
    if ((expedition === null || expedition === undefined) && Array.isArray(body["status"])) {
      return null;
    }
    throw new UnexpectedResponseError("Mondial Relay tracking answered with an unknown shape.");
  }
}
