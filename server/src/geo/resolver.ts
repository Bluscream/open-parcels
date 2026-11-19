import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, type Presentation } from "../parcels/repository.js";
import { GeocodeError, type Place } from "./geocoder.js";
import {
  chooseStops,
  usableCandidates,
  type Candidate,
  type Point,
  type RouteScan,
} from "./route-choice.js";

/** The part of the geocoder the resolver needs; tests pass a fake. */
export interface PlaceSearch {
  search(query: string): Promise<readonly Place[]>;
}

export interface PlaceResolverDeps {
  readonly db: Kysely<Database>;
  readonly geocoder: PlaceSearch;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly presentation: Presentation;
}

/** A name nothing usable was found for is asked again after this long. */
export const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
/** Lookups per run: the geocoder spaces them a second apart, so a run takes a few seconds. */
export const LOOKUPS_PER_RUN = 5;
const RUN_INTERVAL_MS = 60_000;
/** Longer than any carrier's place text; anything longer is not a place name. */
const MAX_TEXT = 200;

/** The cache key of a place text: trimmed, single-spaced, lower case. */
export function placeKey(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const candidatesSchema = z.array(
  z.object({
    label: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    importance: z.number().nullable(),
  }),
);

export interface ResolveSummary {
  /** Place names looked up this run. */
  readonly looked: number;
  /** Events whose looked-up coordinates were set, moved or cleared. */
  readonly events: number;
  /** Parcels told about it. */
  readonly parcels: number;
}

/**
 * Gives scans that name only a place (`location_text` without coordinates) the coordinates of
 * that place, looked up through the geocoder. Each normalised name is looked up once and every
 * usable answer kept in `places`, none too (asked again after 30 days); only the name is sent.
 * Which answer a scan stands for is chosen from the parcel's other scans (see `chooseStops`),
 * and chosen again on every run, so a looked-up point moves or goes when the context changes.
 * Such coordinates are marked `geocoded`, so clients show them as approximate, and a carrier's
 * own position for the same scan replaces them (see the reconciler) and is never touched here.
 */
export class PlaceResolver {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(private readonly deps: PlaceResolverDeps) {}

  start(): void {
    if (this.#timer !== undefined) return;
    const tick = (): void => {
      this.runOnce().catch((error: unknown) => {
        this.deps.logger.warn({ err: error }, "Looking up scan places failed.");
      });
    };
    this.#timer = setInterval(tick, RUN_INTERVAL_MS);
    tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One pass: looks up at most `LOOKUPS_PER_RUN` new names, then places every known one. */
  async runOnce(): Promise<ResolveSummary> {
    if (this.#running) return { looked: 0, events: 0, parcels: 0 };
    this.#running = true;
    try {
      return await this.#run();
    } finally {
      this.#running = false;
    }
  }

  async #run(): Promise<ResolveSummary> {
    const { db } = this.deps;
    // Every scan of the parcels that have one to place or to judge again: the others are context.
    const events = await db
      .selectFrom("parcel_events")
      .select(["id", "parcel_id", "location_text", "latitude", "longitude", "geocoded"])
      .where("parcel_id", "in", (eb) =>
        eb
          .selectFrom("parcel_events")
          .select("parcel_id")
          .where("location_text", "is not", null)
          .where((inner) => inner.or([inner("latitude", "is", null), inner("geocoded", "=", 1)])),
      )
      .orderBy("parcel_id")
      .orderBy("at")
      .orderBy("id")
      .execute();
    // The text to ask for by key: one lookup serves every spelling that normalises the same.
    const texts = new Map<string, string>();
    for (const event of events) {
      const key = openKey(event);
      if (key !== undefined && !texts.has(key)) texts.set(key, event.location_text ?? key);
    }
    if (texts.size === 0) return { looked: 0, events: 0, parcels: 0 };

    const { looked, known } = await this.#lookUp(texts);
    const changes: Change[] = [];
    let from = 0;
    while (from < events.length) {
      const parcelId = events[from]?.parcel_id;
      let to = from;
      while (to < events.length && events[to]?.parcel_id === parcelId) to += 1;
      changes.push(...changesFor(events.slice(from, to), known));
      from = to;
    }
    return { looked, ...(await this.#apply(changes)) };
  }

  /** The candidates of every known name, after looking up at most `LOOKUPS_PER_RUN` due ones. */
  async #lookUp(
    texts: ReadonlyMap<string, string>,
  ): Promise<{ looked: number; known: Map<string, readonly Candidate[]> }> {
    const { db, clock } = this.deps;
    const rows = await db
      .selectFrom("places")
      .selectAll()
      .where("key", "in", [...texts.keys()])
      .execute();
    const known = new Map<string, readonly Candidate[]>();
    const retryBefore = addMs(clock.now(), -MISS_RETRY_MS).toISOString();
    for (const row of rows) {
      const parsed = candidatesSchema.safeParse(parseJson(row.candidates));
      // An unreadable row, or one without candidates that is old enough, is asked again.
      if (!parsed.success || (parsed.data.length === 0 && row.looked_at < retryBefore)) continue;
      known.set(row.key, parsed.data);
    }

    let looked = 0;
    for (const [key, text] of texts) {
      if (known.has(key)) continue;
      if (looked === LOOKUPS_PER_RUN) break;
      let found: readonly Place[];
      try {
        found = await this.deps.geocoder.search(text.trim().replace(/\s+/gu, " "));
      } catch (error) {
        if (!(error instanceof GeocodeError)) throw error;
        // The service is away or refusing: try again next run rather than record a miss.
        this.deps.logger.debug({ err: error }, "Place lookup failed; retrying later.");
        break;
      }
      looked += 1;
      const candidates = usableCandidates(found);
      const row = { key, candidates: JSON.stringify(candidates), looked_at: isoNow(clock) };
      await db
        .insertInto("places")
        .values(row)
        .onConflict((oc) => oc.column("key").doUpdateSet(row))
        .execute();
      known.set(key, candidates);
    }
    return { looked, known };
  }

  async #apply(changes: readonly Change[]): Promise<{ events: number; parcels: number }> {
    if (changes.length === 0) return { events: 0, parcels: 0 };
    const { db, clock } = this.deps;
    let events = 0;
    const touched = await db.transaction().execute(async (trx) => {
      const parcels = new Set<string>();
      for (const change of changes) {
        if (!(await write(trx, change))) continue;
        events += 1;
        parcels.add(change.parcelId);
      }
      const repository = new ParcelRepository(trx, this.deps.presentation);
      for (const parcelId of parcels) {
        const parcel = await repository.get(parcelId);
        if (parcel === undefined) continue;
        await appendEvent(trx, clock, {
          type: "parcel.location_changed",
          parcelId,
          payload: parcelEventPayload(parcel),
        });
      }
      return parcels.size;
    });
    if (touched > 0) {
      await this.deps.bus.notify();
      this.deps.logger.info({ events, parcels: touched }, "Placed scans by their place names.");
    }
    return { events, parcels: touched };
  }
}

interface EventRow {
  readonly id: number;
  readonly parcel_id: string;
  readonly location_text: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly geocoded: number;
}

/** A looked-up position to set or move (`point`) or to clear (null) on one event. */
interface Change {
  readonly id: number;
  readonly parcelId: string;
  readonly point: Point | null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON: the caller's schema check refuses undefined and the name is looked up again.
    return undefined;
  }
}

/** The cache key of an event whose place is the resolver's to decide; undefined for the rest. */
function openKey(event: EventRow): string | undefined {
  if (event.location_text === null) return undefined;
  if (event.latitude !== null && event.geocoded === 0) return undefined;
  const key = placeKey(event.location_text);
  return key === "" || key.length > MAX_TEXT ? undefined : key;
}

/** What to write for one parcel's scans (oldest first) so they match the route's choice. */
function changesFor(
  events: readonly EventRow[],
  known: ReadonlyMap<string, readonly Candidate[]>,
): Change[] {
  const scans = events.map((event): RouteScan => {
    const { latitude, longitude } = event;
    const key = openKey(event);
    if (key !== undefined) return { fixed: null, candidates: known.get(key) ?? null };
    const carrier = latitude !== null && longitude !== null && event.geocoded === 0;
    return { fixed: carrier ? { latitude, longitude } : null, candidates: null };
  });
  const changes: Change[] = [];
  chooseStops(scans).forEach((point, index) => {
    const event = events[index];
    if (point === undefined || event === undefined) return;
    const same =
      (point?.latitude ?? null) === event.latitude &&
      (point?.longitude ?? null) === event.longitude;
    if (!same) changes.push({ id: event.id, parcelId: event.parcel_id, point });
  });
  return changes;
}

/** Writes one change unless the carrier's own position arrived meanwhile; whether it wrote. */
async function write(trx: Transaction<Database>, change: Change): Promise<boolean> {
  const { point } = change;
  const result = await trx
    .updateTable("parcel_events")
    .set(
      point === null
        ? { latitude: null, longitude: null, geocoded: 0 }
        : { latitude: point.latitude, longitude: point.longitude, geocoded: 1 },
    )
    .where("id", "=", change.id)
    .where((eb) => eb.or([eb("latitude", "is", null), eb("geocoded", "=", 1)]))
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}
