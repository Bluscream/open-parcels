import { z } from "zod";

/** One place a search found. */
export interface Place {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
  /** Nominatim's `place_rank` (4 country … 30 building), null when the service did not say. */
  readonly rank: number | null;
  /** Nominatim's `addresstype` (`city`, `country`, `postcode`, …), null when not said. */
  readonly kind: string | null;
  /** Nominatim's `importance` (0–1, higher is better known), null when not said. */
  readonly importance: number | null;
}

/** Settlement types that name a town even when Nominatim ranks the boundary as a state. */
const SETTLEMENTS = new Set(["city", "town", "village", "municipality", "hamlet", "suburb"]);
/** `place_rank` from which a match is a city or finer (13–16 city, 17+ town, suburb, postcode…). */
export const MIN_STOP_RANK = 13;

/**
 * Whether a match is precise enough to stand for a scan's place on a route: a city, town,
 * district, postcode or finer. Countries, states, regions and counties (rank below 13) are
 * not, unless their type is a settlement: city-states such as Hamburg or Berlin are ranked as
 * states but are a city.
 */
export function isStopPrecise(place: Place): boolean {
  if (place.kind !== null && SETTLEMENTS.has(place.kind)) return true;
  return place.rank !== null && place.rank >= MIN_STOP_RANK;
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
/** Enough to reach the right one of several places sharing a name (see route-choice.ts). */
const RESULTS = 8;

const answerSchema = z.array(
  z.object({
    display_name: z.string(),
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    place_rank: z.number().int().optional(),
    addresstype: z.string().optional(),
    importance: z.number().optional(),
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
      rank: entry.place_rank ?? null,
      kind: entry.addresstype ?? null,
      importance: entry.importance ?? null,
    }));
  }
}
