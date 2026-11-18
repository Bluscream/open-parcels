import { z } from "zod";
import {
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type PluginLogger,
  type SessionStore,
  type PluginHttp,
  asObject,
  carrierKey,
  isObject,
  objects,
  readJson,
  text,
  type Json,
} from "../../plugin/api.js";

export const HOST = "tracking.platform-apis.evri.com";
/**
 * The key Evri's public tracking website sends with every request (in the shared rules). It
 * identifies the website, not a user; a refusal of it is Evri's change to make, never a reason
 * to ask the user anything.
 */
const websiteKey = (): string => carrierKey("evri", "website_key");
/** Most parcel ids remembered per source; the oldest are dropped first. */
const MAX_REMEMBERED = 200;

const rememberedSchema = z.record(z.string(), z.string());

async function get(http: PluginHttp, logger: PluginLogger, url: URL): Promise<HttpResponse> {
  const response = await http.request(url, {
    headers: { accept: "application/json", apikey: websiteKey() },
  });
  if (response.status === 401 || response.status === 403) {
    const edge =
      (response.headers.get("server") ?? "").toLowerCase() === "cloudfront" ||
      (response.headers.get("content-type") ?? "").toLowerCase().includes("html");
    logger.warn(
      { status: response.status, edge },
      edge ? "Evri's edge blocked the request." : "Evri refused its own website key.",
    );
    throw new TransientError(`Evri refused the request (HTTP ${response.status}).`);
  }
  return response;
}

/** Evri's internal id for a barcode; null when Evri says the reference is invalid. */
async function resolve(
  http: PluginHttp,
  logger: PluginLogger,
  code: string,
): Promise<string | null> {
  const response = await get(
    http,
    logger,
    new URL(`https://${HOST}/v1/parcels/reference/${encodeURIComponent(code)}`),
  );
  const payload = asObject(readJson(response, "Evri reference lookup"));
  if (
    response.status === 400 &&
    objects(payload["errors"]).some((error) =>
      (text(error["message"]) ?? "").startsWith("Invalid reference:"),
    )
  ) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Evri reference lookup answered HTTP ${response.status}.`);
  }
  const identifiers = payload["parcelIdentifiers"];
  if (!Array.isArray(identifiers)) {
    throw new UnexpectedResponseError("Evri's reference lookup has no parcel identifiers.");
  }
  return (
    objects(identifiers)
      .map((entry) => text(entry["urn"]))
      .find((urn) => urn !== null) ?? null
  );
}

/** The parcel whose identifiers include the barcode; a single result is taken as it. */
async function detail(
  http: PluginHttp,
  logger: PluginLogger,
  ids: { code: string; urn: string; postcode: string },
): Promise<Json | null> {
  const url = new URL(`https://${HOST}/v1/parcels`);
  url.searchParams.set("uniqueIds", ids.urn);
  url.searchParams.set("postcode", ids.postcode);
  const response = await get(http, logger, url);
  if (response.status !== 200) {
    throw new TransientError(`Evri parcel lookup answered HTTP ${response.status}.`);
  }
  const results = asObject(readJson(response, "Evri parcel lookup"))["results"];
  if (!Array.isArray(results)) {
    throw new UnexpectedResponseError("Evri's parcel lookup has no results.");
  }
  const parcels = results.filter(isObject);
  const matching = parcels.find((parcel) =>
    objects(parcel["parcelIdentifiers"]).some(
      (entry) => (text(entry["value"]) ?? text(entry["barcode"]))?.toUpperCase() === ids.code,
    ),
  );
  if (matching !== undefined || parcels.length <= 1) {
    return matching ?? parcels[0] ?? null;
  }
  throw new UnexpectedResponseError("Evri's parcel lookup did not include the barcode.");
}

/**
 * Looks barcodes up in two steps: barcode to Evri's id, then id plus postcode to the parcel.
 * Ids are remembered in the session store; a remembered id that finds nothing is resolved again,
 * once, in case Evri re-issued it.
 */
export class EvriTracking {
  /** Insertion-ordered, so the oldest entries come first. */
  readonly #remembered: Map<string, string>;
  #changed = false;

  constructor(
    private readonly http: PluginHttp,
    private readonly logger: PluginLogger,
    private readonly session: SessionStore,
  ) {
    const stored = rememberedSchema.safeParse(session.load());
    this.#remembered = new Map(stored.success ? Object.entries(stored.data) : []);
  }

  async parcel(code: string, postcode: string): Promise<Json | null> {
    const known = this.#remembered.get(code);
    if (known !== undefined) {
      const found = await detail(this.http, this.logger, { code, urn: known, postcode });
      if (found !== null) {
        return found;
      }
    }
    const urn = await resolve(this.http, this.logger, code);
    if (urn === null || urn === known) {
      return null;
    }
    this.#remember(code, urn);
    return detail(this.http, this.logger, { code, urn, postcode });
  }

  #remember(code: string, urn: string): void {
    this.#remembered.delete(code);
    this.#remembered.set(code, urn);
    const codes = [...this.#remembered.keys()];
    for (const old of codes.slice(0, Math.max(0, codes.length - MAX_REMEMBERED))) {
      this.#remembered.delete(old);
    }
    this.#changed = true;
  }

  async save(): Promise<void> {
    if (this.#changed) {
      await this.session.save(Object.fromEntries(this.#remembered));
    }
  }
}
