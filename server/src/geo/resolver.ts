import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, type Presentation } from "../parcels/repository.js";
import { GeocodeError, isStopPrecise, type Place } from "./geocoder.js";

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

export interface ResolveSummary {
  /** Place names looked up this run. */
  readonly looked: number;
  /** Events that gained coordinates. */
  readonly events: number;
  /** Parcels told about it. */
  readonly parcels: number;
}

/**
 * Gives scans that name only a place (`location_text` without coordinates) the coordinates of
 * that place, looked up through the geocoder. Each normalised name is looked up once and kept in
 * `places`, a miss too (asked again after 30 days); only the name is sent. Such coordinates are
 * marked `geocoded`, so clients show them as approximate, and a carrier's own position for the
 * same scan replaces them (see the reconciler).
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

  /** One pass: looks up at most `LOOKUPS_PER_RUN` new names, then fills every known one. */
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
    const { db, clock } = this.deps;
    const rows = await db
      .selectFrom("parcel_events")
      .select("location_text")
      .distinct()
      .where("latitude", "is", null)
      .where("location_text", "is not", null)
      .execute();
    // Texts by key: one lookup serves every spelling that normalises the same.
    const texts = new Map<string, string[]>();
    for (const { location_text: text } of rows) {
      if (text === null) continue;
      const key = placeKey(text);
      if (key === "" || key.length > MAX_TEXT) continue;
      const list = texts.get(key);
      if (list === undefined) texts.set(key, [text]);
      else list.push(text);
    }
    if (texts.size === 0) return { looked: 0, events: 0, parcels: 0 };

    const known = await db
      .selectFrom("places")
      .selectAll()
      .where("key", "in", [...texts.keys()])
      .execute();
    const byKey = new Map(known.map((row) => [row.key, row]));
    const retryBefore = addMs(clock.now(), -MISS_RETRY_MS).toISOString();
    const due = [...texts.keys()].filter((key) => {
      const row = byKey.get(key);
      return row === undefined || (row.latitude === null && (row.missed_at ?? "") < retryBefore);
    });

    let looked = 0;
    for (const key of due.slice(0, LOOKUPS_PER_RUN)) {
      const text = texts.get(key)?.[0]?.trim().replace(/\s+/gu, " ") ?? key;
      let best: Place | undefined;
      try {
        // Only the first answer counts: a weaker match further down is likely another place.
        best = (await this.deps.geocoder.search(text))[0];
      } catch (error) {
        if (!(error instanceof GeocodeError)) throw error;
        // The service is away or refusing: try again next run rather than record a miss.
        this.deps.logger.debug({ err: error }, "Place lookup failed; retrying later.");
        break;
      }
      looked += 1;
      const hit = best !== undefined && isStopPrecise(best) ? best : undefined;
      const now = isoNow(clock);
      const row = {
        key,
        latitude: hit?.latitude ?? null,
        longitude: hit?.longitude ?? null,
        precision: hit === undefined ? null : ("area" as const),
        resolved_at: hit === undefined ? null : now,
        missed_at: hit === undefined ? now : null,
      };
      await db
        .insertInto("places")
        .values(row)
        .onConflict((oc) => oc.column("key").doUpdateSet(row))
        .execute();
      byKey.set(key, row);
    }

    const updates: { texts: string[]; latitude: number; longitude: number }[] = [];
    for (const [key, spellings] of texts) {
      const latitude = byKey.get(key)?.latitude ?? null;
      const longitude = byKey.get(key)?.longitude ?? null;
      if (latitude !== null && longitude !== null) {
        updates.push({ texts: spellings, latitude, longitude });
      }
    }
    return { looked, ...(await this.#apply(updates)) };
  }

  async #apply(
    updates: readonly { texts: string[]; latitude: number; longitude: number }[],
  ): Promise<{ events: number; parcels: number }> {
    if (updates.length === 0) return { events: 0, parcels: 0 };
    const { db, clock } = this.deps;
    let events = 0;
    const touched = await db.transaction().execute(async (trx) => {
      const parcels = new Set<string>();
      for (const update of updates) {
        const hit = await trx
          .selectFrom("parcel_events")
          .select("parcel_id")
          .where("latitude", "is", null)
          .where("location_text", "in", update.texts)
          .execute();
        if (hit.length === 0) continue;
        for (const row of hit) parcels.add(row.parcel_id);
        const result = await trx
          .updateTable("parcel_events")
          .set({ latitude: update.latitude, longitude: update.longitude, geocoded: 1 })
          .where("latitude", "is", null)
          .where("location_text", "in", update.texts)
          .executeTakeFirst();
        events += Number(result.numUpdatedRows);
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
