import { z } from "zod";

/** One place a search found. */
export interface Place {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

export class GeocodeError extends Error {
  override readonly name = "GeocodeError";
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface GeocoderOptions {
  readonly userAgent: string;
  /** Nominatim-compatible search endpoint. */
  readonly endpoint?: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
/** Nominatim's usage policy: at most one request per second, from an identified client. */
const MIN_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 10_000;
const CACHE_SIZE = 200;
const RESULTS = 5;

const answerSchema = z.array(
  z.object({
    display_name: z.string(),
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
  }),
);

/**
 * Turns an address or place name into coordinates through OpenStreetMap's Nominatim, as the
 * settings page's home search does. Requests are queued one per second and answers cached, as
 * the usage policy asks; only the typed text leaves the server.
 */
export class Geocoder {
  readonly #cache = new Map<string, readonly Place[]>();
  #queue: Promise<unknown> = Promise.resolve();
  #last = 0;

  constructor(private readonly options: GeocoderOptions) {}

  async search(query: string, language?: string): Promise<readonly Place[]> {
    const text = query.trim().replace(/\s+/gu, " ");
    if (text.length === 0) {
      return [];
    }
    const key = `${language ?? ""}\u0000${text.toLowerCase()}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const run = this.#queue.then(() => this.#fetch(text, language));
    this.#queue = run.catch(() => undefined);
    const places = await run;
    this.#cache.set(key, places);
    if (this.#cache.size > CACHE_SIZE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return places;
  }

  async #fetch(text: string, language: string | undefined): Promise<readonly Place[]> {
    const now = this.options.now ?? Date.now;
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const wait = this.#last + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    this.#last = now();

    const url = new URL(this.options.endpoint ?? NOMINATIM);
    url.searchParams.set("q", text);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(RESULTS));
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          "user-agent": this.options.userAgent,
          accept: "application/json",
          ...(language === undefined ? {} : { "accept-language": language }),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new GeocodeError("The place search could not be reached.");
    }
    if (!response.ok) {
      throw new GeocodeError(`The place search answered HTTP ${String(response.status)}.`);
    }
    const parsed = answerSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new GeocodeError("The place search answered something unexpected.");
    }
    return parsed.data.map((entry) => ({
      label: entry.display_name,
      latitude: entry.lat,
      longitude: entry.lon,
    }));
  }
}
