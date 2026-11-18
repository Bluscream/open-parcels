import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { Database, ParcelUpdate } from "../db/schema.js";
import {
  effectiveStatus,
  type Direction,
  type Parcel,
  type ParcelStatus,
} from "../domain/parcel.js";
import { deriveEvents, type EventView } from "../engine/rules.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "./repository.js";

export class DuplicateParcelError extends Error {
  override readonly name = "DuplicateParcelError";

  constructor(readonly existingId: string) {
    super("This parcel is already tracked.");
  }
}

export interface NewParcelInput {
  readonly carrier: string;
  readonly barcode: string;
  readonly direction: Direction;
  readonly label: string | null;
}

export interface ParcelPatch {
  readonly label?: string | null;
  readonly manualStatus?: ParcelStatus | null;
  readonly archived?: boolean;
}

/**
 * Called after a code was added by hand, so the carrier's tracking source picks it up. Returns the
 * source id it was linked to, or undefined when no installed plug-in can track this carrier.
 */
export type TrackingLinker = (carrier: string) => Promise<string | undefined>;

function view(parcel: Parcel): EventView {
  const status = effectiveStatus(parcel);
  return {
    direction: parcel.direction,
    status,
    delivered: parcel.manual_status === null ? parcel.delivered : status === "delivered",
    plannedFrom: parcel.planned_from,
    plannedTo: parcel.planned_to,
  };
}

/** User-initiated parcel changes. Carrier updates go through the reconciler instead. */
export class ParcelService {
  readonly repository: ParcelRepository;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly linkTracking: TrackingLinker,
    private readonly presentation: Presentation = RAW_PRESENTATION,
  ) {
    this.repository = new ParcelRepository(db, presentation);
  }

  async create(input: NewParcelInput): Promise<Parcel> {
    const existing = await this.repository.findIdByBarcode(input.carrier, input.barcode);
    if (existing !== undefined) {
      throw new DuplicateParcelError(existing);
    }
    const sourceId = await this.linkTracking(input.carrier);
    const id = crypto.randomUUID();
    const now = isoNow(this.clock);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("parcels")
        .values({
          id,
          carrier: input.carrier,
          barcode: input.barcode,
          direction: input.direction,
          status: "registered",
          raw_status: null,
          delivered: 0,
          pickup: 0,
          label: input.label,
          first_seen_at: now,
          last_seen_at: now,
          updated_at: now,
        })
        .execute();
      if (sourceId !== undefined) {
        await trx
          .insertInto("parcel_sources")
          .values({
            parcel_id: id,
            source_id: sourceId,
            external_ref: null,
            role: "primary",
            last_seen_at: now,
          })
          .execute();
      }
      const parcel = await new ParcelRepository(trx, this.presentation).get(id);
      if (parcel === undefined) {
        throw new Error("Inserted parcel could not be read back.");
      }
      for (const event of deriveEvents(null, view(parcel))) {
        await appendEvent(trx, this.clock, {
          type: event.type,
          parcelId: id,
          payload: parcelEventPayload(parcel, event.changes),
        });
      }
    });
    await this.bus.notify();
    return this.#mustGet(id);
  }

  /** Applies a user edit. Returns undefined when the parcel does not exist. */
  async update(id: string, patch: ParcelPatch): Promise<Parcel | undefined> {
    const before = await this.repository.get(id);
    if (before === undefined) {
      return undefined;
    }
    const now = isoNow(this.clock);
    const changes: ParcelUpdate = { updated_at: now };
    if (patch.label !== undefined) {
      changes.label = patch.label;
    }
    if (patch.manualStatus !== undefined) {
      changes.manual_status = patch.manualStatus;
    }
    if (patch.archived !== undefined) {
      changes.archived_at = patch.archived ? now : null;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable("parcels").set(changes).where("id", "=", id).execute();
      const after = await new ParcelRepository(trx, this.presentation).get(id);
      if (after === undefined) {
        return;
      }
      for (const event of deriveEvents(view(before), view(after))) {
        await appendEvent(trx, this.clock, {
          type: event.type,
          parcelId: id,
          payload: parcelEventPayload(after, event.changes),
        });
      }
    });
    await this.bus.notify();
    return this.#mustGet(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("parcels").where("id", "=", id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async #mustGet(id: string): Promise<Parcel> {
    const parcel = await this.repository.get(id);
    if (parcel === undefined) {
      throw new Error("Parcel disappeared while being written.");
    }
    return parcel;
  }
}
