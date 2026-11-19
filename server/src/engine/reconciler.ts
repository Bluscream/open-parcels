import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database, ParcelRow, SourceRow } from "../db/schema.js";
import { effectiveStatus, PARCEL_STATUSES, type ParcelStatus } from "../domain/parcel.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { parcelEventPayload } from "../events/payload.js";
import { ParcelRepository, RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";
import type { FetchResult, LiveTarget } from "../plugin/api.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../plugin/snapshot.js";
import { healState, mergeParcel, type Authority, type ParcelState } from "./merge.js";
import { deriveEvents, type EventView } from "./rules.js";
import { utcSnapshot } from "./utc.js";
import { maskIdentifiers, recordUnknown, type UnknownValue } from "./vocab.js";

/** A parcel missing from every complete listing for this long, undelivered, counts as removed. */
export const REMOVAL_GRACE_MS = 6 * 60 * 60 * 1000;

type Trx = Transaction<Database>;

export interface LiveTargetOfParcel {
  readonly parcelId: string;
  readonly target: LiveTarget;
}

export interface IngestSummary {
  readonly created: number;
  readonly updated: number;
  readonly events: number;
  /** Parcels the carrier can show on a courier map; handed to the live tracker, never stored. */
  readonly liveTargets: readonly LiveTargetOfParcel[];
  /** Parcels a tracking run asked the carrier about, and how many of them it returned. */
  readonly asked: number;
  readonly found: number;
}

function asStatus(value: string | null): ParcelStatus | null {
  return value !== null && PARCEL_STATUSES.includes(value as ParcelStatus)
    ? (value as ParcelStatus)
    : null;
}

function rowToState(row: ParcelRow): ParcelState {
  return {
    direction: row.direction,
    status: asStatus(row.status) ?? "unknown",
    rawStatus: row.raw_status,
    statusAt: row.status_at,
    delivered: row.delivered === 1,
    deliveredAt: row.delivered_at,
    plannedFrom: row.planned_from,
    plannedTo: row.planned_to,
    pickup: row.pickup === 1,
    pickupPoint: row.pickup_point,
    url: row.url,
    sender: row.sender,
    receiver: row.receiver,
    weightKg: row.weight_kg,
  };
}

function eventView(state: ParcelState, manualStatus: ParcelStatus | null): EventView {
  return {
    direction: state.direction,
    status: effectiveStatus({ status: state.status, manual_status: manualStatus }),
    delivered: manualStatus === null ? state.delivered : manualStatus === "delivered",
    plannedFrom: state.plannedFrom,
    plannedTo: state.plannedTo,
  };
}

function stateColumns(state: ParcelState) {
  return {
    status: state.status,
    raw_status: state.rawStatus,
    status_at: state.statusAt,
    delivered: state.delivered ? (1 as const) : (0 as const),
    delivered_at: state.deliveredAt,
    planned_from: state.plannedFrom,
    planned_to: state.plannedTo,
    pickup: state.pickup ? (1 as const) : (0 as const),
    pickup_point: state.pickupPoint,
    url: state.url,
    sender: state.sender,
    receiver: state.receiver,
    weight_kg: state.weightKg,
  };
}

/** An entry's identity: the source's own id when it has one, else time, text and place. */
export function fingerprint(
  event: Pick<SnapshotEvent, "at" | "rawStatus" | "location" | "id">,
): string {
  const basis =
    event.id === undefined
      ? `${event.at}\u0000${event.rawStatus}\u0000${event.location ?? ""}`
      : `id\u0000${event.id}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * A mail whose wording no rule maps, recorded so it can be added to the rules. Identifiers in the
 * subject are masked; the carrier goes in the plug-in column so the right table is obvious.
 */
function unmappedMail(snapshot: ParcelSnapshot): UnknownValue | null {
  const raw = snapshot.rawStatus;
  if (snapshot.status !== null || snapshot.delivered || raw === null) {
    return null;
  }
  const key = maskIdentifiers(raw);
  return key === "" ? null : { plugin: snapshot.carrier, kind: "mail_subject", key };
}

/** The parcel's stored history from every source, as merge input. */
async function storedHistory(trx: Trx, parcelId: string): Promise<SnapshotEvent[]> {
  const rows = await trx
    .selectFrom("parcel_events")
    .select(["at", "status", "raw_status", "location_text"])
    .where("parcel_id", "=", parcelId)
    .execute();
  return rows.map((row) => ({
    at: row.at,
    status: asStatus(row.status),
    rawStatus: row.raw_status,
    location: row.location_text,
  }));
}

/**
 * Long enough to be a carrier's tracking code rather than a shop's own shipment key, so a shared
 * value across carriers means the same parcel.
 */
function isCarrierCode(barcode: string): boolean {
  return /^[A-Z0-9]{8,40}$/i.test(barcode);
}

/**
 * Parcels stored under a shop's name (a plug-in that has a shop source) with this code, other than
 * `carrier`'s. Imported parcels count too, linked to the shop or not.
 */
async function shopTwins(
  trx: Trx,
  barcode: string,
  carrier: string,
): Promise<{ carrier: string; barcode: string }[]> {
  return trx
    .selectFrom("parcels")
    .select(["parcels.carrier", "parcels.barcode"])
    .where("parcels.barcode", "=", barcode)
    .where("parcels.carrier", "!=", carrier)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("sources")
          .select("sources.id")
          .where("sources.kind", "=", "shop")
          .whereRef("sources.plugin", "=", "parcels.carrier"),
      ),
    )
    .execute();
}

async function findParcel(
  trx: Trx,
  carrier: string,
  barcode: string,
): Promise<ParcelRow | undefined> {
  return trx
    .selectFrom("parcels")
    .selectAll()
    .where("carrier", "=", carrier)
    .where("barcode", "=", barcode)
    .executeTakeFirst();
}

/**
 * The only writer of carrier data. Turns plug-in snapshots into stored parcels and canonical
 * events, in one transaction per source run.
 */
export class Reconciler {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly presentation: Presentation = RAW_PRESENTATION,
  ) {}

  /**
   * Applies one source run. `asked` lists the parcels a tracking run asked the carrier about;
   * each is marked found or not found, so a code the carrier does not know is visible on the
   * parcel (`lookup`) instead of silently staying `registered`. No event fires for it.
   */
  async ingest(
    sourceId: string,
    result: FetchResult,
    asked: readonly string[] = [],
  ): Promise<IngestSummary> {
    const source = await this.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (source === undefined) {
      throw new Error(`Unknown source ${sourceId}.`);
    }
    const summary = {
      created: 0,
      updated: 0,
      events: 0,
      liveTargets: [] as LiveTargetOfParcel[],
      asked: asked.length,
      found: 0,
    };
    const unknown: UnknownValue[] = [];
    await this.db.transaction().execute(async (trx) => {
      const seen = new Set<string>();
      for (const reported of result.snapshots) {
        const snapshot = utcSnapshot(reported);
        const value = source.kind === "mail" ? unmappedMail(snapshot) : null;
        if (value !== null) {
          unknown.push(value);
        }
        const outcome = await this.#applySnapshot(trx, source, snapshot);
        seen.add(outcome.parcelId);
        if (snapshot.live !== null) {
          summary.liveTargets.push({ parcelId: outcome.parcelId, target: snapshot.live });
        }
        summary[outcome.created ? "created" : "updated"] += 1;
        summary.events += outcome.events;
      }
      // A tracking source only answers for the codes it was asked about. Whether such a code is
      // gone is the not-found lookup state's call (archived after 30 days, ADR §2.5), never
      // `parcel.removed`, whatever the plug-in says about completeness.
      if (result.complete && source.kind !== "tracking") {
        await this.#markMissing(trx, sourceId, seen);
      }
      summary.found = await this.#recordLookup(trx, asked, seen);
    });
    await this.bus.notify();
    const vocab = { db: this.db, bus: this.bus, clock: this.clock };
    for (const value of unknown) {
      // Recording is best effort; the parcels are already stored.
      await recordUnknown(vocab, value, this.logger).catch((error: unknown) => {
        this.logger.error({ err: error }, "Recording an unrecognised value failed.");
      });
    }
    summary.events += await this.judgeRemovals();
    return summary;
  }

  /**
   * Repairs parcels stored under the old merge rules (`unknown` while a stored entry maps, or
   * delivered in status only), from their stored history. Idempotent; run at startup.
   */
  async repair(): Promise<number> {
    const twins = await this.db.transaction().execute((trx) => this.#foldStoredTwins(trx));
    if (twins > 0) {
      await this.bus.notify();
      this.logger.info({ folded: twins }, "Folded shop parcels into their carriers' parcels.");
    }
    const candidates = await this.db
      .selectFrom("parcels")
      .select("id")
      .where((eb) =>
        eb.or([
          eb("status", "=", "unknown"),
          eb.and([eb("status", "=", "delivered"), eb("delivered", "=", 0)]),
        ]),
      )
      .execute();
    let repaired = 0;
    await this.db.transaction().execute(async (trx) => {
      for (const { id } of candidates) {
        repaired += (await this.#repairOne(trx, id)) ? 1 : 0;
      }
    });
    if (repaired > 0) {
      await this.bus.notify();
      this.logger.info({ repaired }, "Repaired parcel statuses from their stored history.");
    }
    return repaired;
  }

  async #repairOne(trx: Trx, parcelId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("parcels")
      .selectAll()
      .where("id", "=", parcelId)
      .executeTakeFirstOrThrow();
    const before = rowToState(row);
    const after = healState(before, await storedHistory(trx, parcelId));
    if (after === null) {
      return false;
    }
    await trx
      .updateTable("parcels")
      .set({ ...stateColumns(after), updated_at: isoNow(this.clock) })
      .where("id", "=", parcelId)
      .execute();
    const manual = asStatus(row.manual_status);
    const derived = deriveEvents(eventView(before, manual), eventView(after, manual));
    const parcel =
      derived.length === 0
        ? undefined
        : await new ParcelRepository(trx, this.presentation).get(parcelId);
    if (parcel === undefined) {
      return true;
    }
    for (const event of derived) {
      await appendEvent(trx, this.clock, {
        type: event.type,
        parcelId,
        payload: parcelEventPayload(parcel, event.changes),
      });
    }
    return true;
  }

  async #applySnapshot(
    trx: Trx,
    source: SourceRow,
    reported: ParcelSnapshot,
  ): Promise<{ parcelId: string; created: boolean; events: number }> {
    const snapshot = await this.#withInferredHandoff(trx, source, reported);
    if (snapshot.handoff === null && source.kind !== "shop" && source.kind !== "mail") {
      await this.#adoptShopTwin(trx, snapshot);
    }
    const key = snapshot.handoff ?? { carrier: snapshot.carrier, barcode: snapshot.barcode };
    const authority: Authority =
      snapshot.handoff === null && source.kind !== "mail" ? "carrier" : "secondary";
    const role =
      snapshot.handoff !== null ? "handoff" : source.kind === "mail" ? "mail" : "primary";
    const now = isoNow(this.clock);

    let existing = await findParcel(trx, key.carrier, key.barcode);
    if (snapshot.handoff !== null) {
      existing = await this.#foldShopDuplicate(trx, snapshot, existing);
    }
    const before = existing === undefined ? null : rowToState(existing);
    const manual = existing === undefined ? null : asStatus(existing.manual_status);
    const after = mergeParcel(
      before,
      { ...snapshot, carrier: key.carrier, barcode: key.barcode },
      authority,
      existing === undefined ? [] : await storedHistory(trx, existing.id),
    );
    const parcelId = existing?.id ?? crypto.randomUUID();
    const orderId = await this.#upsertOrder(trx, snapshot, now);

    if (existing === undefined) {
      await trx
        .insertInto("parcels")
        .values({
          id: parcelId,
          carrier: key.carrier,
          barcode: key.barcode,
          direction: after.direction,
          ...stateColumns(after),
          label: null,
          order_id: orderId,
          first_seen_at: now,
          last_seen_at: now,
          updated_at: now,
        })
        .execute();
    } else {
      await trx
        .updateTable("parcels")
        .set({
          ...stateColumns(after),
          order_id: orderId ?? existing.order_id,
          last_seen_at: now,
          updated_at: now,
          removed_at: null,
        })
        .where("id", "=", parcelId)
        .execute();
    }
    await this.#writeRelated(trx, { parcelId, sourceId: source.id, role, snapshot, now });

    const derived = deriveEvents(
      before === null ? null : eventView(before, manual),
      eventView(after, manual),
    );
    if (derived.length > 0) {
      const parcel = await new ParcelRepository(trx, this.presentation).get(parcelId);
      for (const event of derived) {
        if (parcel !== undefined) {
          await appendEvent(trx, this.clock, {
            type: event.type,
            parcelId,
            payload: parcelEventPayload(parcel, event.changes),
          });
        }
      }
    }
    return { parcelId, created: existing === undefined, events: derived.length };
  }

  /**
   * A shop that reports a carrier's code without naming the carrier (an unmapped carrier code, a
   * page without tracking details) still hands the parcel off: when exactly one parcel of another
   * carrier has the same code, the shop's snapshot becomes a hand-off to it.
   */
  async #withInferredHandoff(
    trx: Trx,
    source: SourceRow,
    snapshot: ParcelSnapshot,
  ): Promise<ParcelSnapshot> {
    if (snapshot.handoff !== null || source.kind !== "shop" || !isCarrierCode(snapshot.barcode)) {
      return snapshot;
    }
    const twins = await trx
      .selectFrom("parcels")
      .select(["carrier", "barcode"])
      .where("barcode", "=", snapshot.barcode)
      .where("carrier", "!=", snapshot.carrier)
      .execute();
    const [twin] = twins;
    return twins.length === 1 && twin !== undefined
      ? { ...snapshot, handoff: { carrier: twin.carrier, barcode: twin.barcode } }
      : snapshot;
  }

  /**
   * The reverse: a carrier reports a code that a shop already stored under its own name. The shop's
   * parcel is folded into the carrier's, so the code is one parcel with two sources.
   */
  async #adoptShopTwin(trx: Trx, snapshot: ParcelSnapshot): Promise<void> {
    if (!isCarrierCode(snapshot.barcode)) {
      return;
    }
    const twins = await shopTwins(trx, snapshot.barcode, snapshot.carrier);
    const [twin] = twins;
    if (twins.length !== 1 || twin === undefined) {
      return;
    }
    const target = await findParcel(trx, snapshot.carrier, snapshot.barcode);
    await this.#foldShopDuplicate(
      trx,
      {
        ...snapshot,
        carrier: twin.carrier,
        barcode: twin.barcode,
        handoff: { carrier: snapshot.carrier, barcode: snapshot.barcode },
      },
      target,
    );
  }

  /**
   * Repairs codes stored twice, once by a shop and once by the carrier that delivers it, from
   * before hand-offs were inferred. Each pair becomes one parcel under the carrier. Idempotent.
   */
  async #foldStoredTwins(trx: Trx): Promise<number> {
    const shopPlugins = await trx
      .selectFrom("sources")
      .select("plugin")
      .where("kind", "=", "shop")
      .distinct()
      .execute();
    if (shopPlugins.length === 0) {
      return 0;
    }
    const rows = await trx
      .selectFrom("parcels")
      .select(["carrier", "barcode"])
      .where(
        "carrier",
        "in",
        shopPlugins.map((row) => row.plugin),
      )
      .execute();
    let folded = 0;
    for (const shop of rows) {
      if (!isCarrierCode(shop.barcode)) {
        continue;
      }
      const others = await trx
        .selectFrom("parcels")
        .selectAll()
        .where("barcode", "=", shop.barcode)
        .where("carrier", "!=", shop.carrier)
        .execute();
      const [target] = others;
      if (others.length !== 1 || target === undefined) {
        continue;
      }
      await this.#foldShopDuplicate(
        trx,
        snapshot({
          carrier: shop.carrier,
          barcode: shop.barcode,
          status: null,
          rawStatus: null,
          handoff: { carrier: target.carrier, barcode: target.barcode },
        }),
        target,
      );
      folded += 1;
    }
    return folded;
  }

  /**
   * A shop may have reported a parcel under its own key before it knew the real carrier. Once the
   * hand-off is known, that entry is moved under the carrier's key, or folded into the carrier's
   * parcel if one exists, so there is never a duplicate.
   */
  async #foldShopDuplicate(
    trx: Trx,
    snapshot: ParcelSnapshot,
    target: ParcelRow | undefined,
  ): Promise<ParcelRow | undefined> {
    const handoff = snapshot.handoff;
    if (handoff === null) {
      return target;
    }
    const duplicate = await findParcel(trx, snapshot.carrier, snapshot.barcode);
    if (duplicate === undefined || duplicate.id === target?.id) {
      return target;
    }
    if (target === undefined) {
      await trx
        .updateTable("parcels")
        .set({ carrier: handoff.carrier, barcode: handoff.barcode })
        .where("id", "=", duplicate.id)
        .execute();
      // The shop's links now hand the parcel off; the carrier's own source becomes primary.
      await trx
        .updateTable("parcel_sources")
        .set({ role: "handoff" })
        .where("parcel_id", "=", duplicate.id)
        .where("role", "=", "primary")
        .execute();
      this.logger.debug({ parcelId: duplicate.id }, "Re-keyed a shop parcel under its carrier.");
      return { ...duplicate, carrier: handoff.carrier, barcode: handoff.barcode };
    }
    // Copy history and links over, skipping what the target already has; the duplicate's own rows
    // go away with it through the foreign-key cascade.
    await trx
      .insertInto("parcel_events")
      .columns([
        "parcel_id",
        "source_id",
        "at",
        "status",
        "raw_status",
        "location_text",
        "fingerprint",
      ])
      .expression((eb) =>
        eb
          .selectFrom("parcel_events")
          .select([
            eb.val(target.id).as("parcel_id"),
            "source_id",
            "at",
            "status",
            "raw_status",
            "location_text",
            "fingerprint",
          ])
          .where("parcel_id", "=", duplicate.id),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto("parcel_sources")
      .columns(["parcel_id", "source_id", "external_ref", "role", "last_seen_at", "missing_since"])
      .expression((eb) =>
        eb
          .selectFrom("parcel_sources")
          .select([
            eb.val(target.id).as("parcel_id"),
            "source_id",
            "external_ref",
            eb.val("handoff").as("role"),
            "last_seen_at",
            "missing_since",
          ])
          .where("parcel_id", "=", duplicate.id),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .updateTable("items")
      .set({ parcel_id: target.id })
      .where("parcel_id", "=", duplicate.id)
      .execute();
    // What the user or the shop knew about the duplicate is kept where the target has nothing.
    await trx
      .updateTable("parcels")
      .set({
        order_id: target.order_id ?? duplicate.order_id,
        label: target.label ?? duplicate.label,
        manual_status: target.manual_status ?? duplicate.manual_status,
      })
      .where("id", "=", target.id)
      .execute();
    const gone = await new ParcelRepository(trx, this.presentation).get(duplicate.id);
    await trx.deleteFrom("parcels").where("id", "=", duplicate.id).execute();
    if (gone !== undefined) {
      await appendEvent(trx, this.clock, {
        type: "parcel.deleted",
        parcelId: duplicate.id,
        payload: { ...parcelEventPayload({ ...gone, history: [] }), merged_into: target.id },
      });
    }
    this.logger.debug({ parcelId: target.id }, "Folded a shop duplicate into the carrier parcel.");
    return target;
  }

  async #upsertOrder(trx: Trx, snapshot: ParcelSnapshot, now: string): Promise<string | null> {
    if (snapshot.order === null) {
      return null;
    }
    const existing = await trx
      .selectFrom("orders")
      .select("id")
      .where("shop", "=", snapshot.order.shop)
      .where("order_number", "=", snapshot.order.orderNumber)
      .executeTakeFirst();
    if (existing !== undefined) {
      await trx
        .updateTable("orders")
        .set({ placed_at: snapshot.order.placedAt, updated_at: now })
        .where("id", "=", existing.id)
        .execute();
      return existing.id;
    }
    const id = crypto.randomUUID();
    await trx
      .insertInto("orders")
      .values({
        id,
        shop: snapshot.order.shop,
        order_number: snapshot.order.orderNumber,
        placed_at: snapshot.order.placedAt,
        status: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async #writeRelated(
    trx: Trx,
    input: {
      parcelId: string;
      sourceId: string;
      role: "primary" | "handoff" | "mail";
      snapshot: ParcelSnapshot;
      now: string;
    },
  ): Promise<void> {
    const { parcelId, sourceId, role, snapshot, now } = input;
    await trx
      .insertInto("parcel_sources")
      .values({
        parcel_id: parcelId,
        source_id: sourceId,
        external_ref: snapshot.externalRef,
        role,
        last_seen_at: now,
        missing_since: null,
      })
      .onConflict((oc) =>
        oc.columns(["parcel_id", "source_id"]).doUpdateSet({
          external_ref: snapshot.externalRef,
          role,
          last_seen_at: now,
          missing_since: null,
        }),
      )
      .execute();
    for (const event of snapshot.history) {
      await trx
        .insertInto("parcel_events")
        .values({
          parcel_id: parcelId,
          source_id: sourceId,
          at: event.at,
          status: event.status,
          raw_status: event.rawStatus,
          location_text: event.location,
          fingerprint: fingerprint(event),
        })
        .onConflict((oc) => oc.columns(["parcel_id", "fingerprint"]).doNothing())
        .execute();
    }
    if (snapshot.items.length > 0) {
      await trx.deleteFrom("items").where("parcel_id", "=", parcelId).execute();
      await trx
        .insertInto("items")
        .values(
          snapshot.items.map((item, position) => ({
            parcel_id: parcelId,
            position,
            title: item.title,
            image_ref: item.imageUrl,
            url: item.url,
            external_id: item.externalId,
            quantity: item.quantity,
            price: item.price,
            currency: item.currency,
          })),
        )
        .execute();
    }
    if (snapshot.raw !== null) {
      await trx
        .insertInto("parcel_raw")
        .values({
          parcel_id: parcelId,
          source_id: sourceId,
          fetched_at: now,
          payload: JSON.stringify(snapshot.raw),
        })
        .onConflict((oc) =>
          oc
            .columns(["parcel_id", "source_id"])
            .doUpdateSet({ fetched_at: now, payload: JSON.stringify(snapshot.raw) }),
        )
        .execute();
    }
  }

  /** Marks the asked parcels found or not found; `since` moves only when the state changes. */
  async #recordLookup(
    trx: Trx,
    asked: readonly string[],
    seen: ReadonlySet<string>,
  ): Promise<number> {
    if (asked.length === 0) {
      return 0;
    }
    const now = isoNow(this.clock);
    const found = asked.filter((id) => seen.has(id));
    const missing = asked.filter((id) => !seen.has(id));
    for (const [ids, state] of [
      [found, "found"],
      [missing, "not_found"],
    ] as const) {
      if (ids.length === 0) {
        continue;
      }
      await trx
        .updateTable("parcels")
        .set((eb) => ({
          lookup_since: eb
            .case()
            .when("lookup_state", "=", state)
            .then(eb.ref("lookup_since"))
            .else(now)
            .end(),
          lookup_state: state,
          lookup_checked_at: now,
        }))
        .where("id", "in", ids)
        .execute();
    }
    return found.length;
  }

  async #markMissing(trx: Trx, sourceId: string, seen: ReadonlySet<string>): Promise<void> {
    let query = trx
      .updateTable("parcel_sources")
      .set({ missing_since: isoNow(this.clock) })
      .where("source_id", "=", sourceId)
      .where("missing_since", "is", null);
    if (seen.size > 0) {
      query = query.where("parcel_id", "not in", [...seen]);
    }
    await query.execute();
  }

  /**
   * Fires `parcel.removed` for active parcels that every linked source has stopped listing for
   * the grace period. While any linked source is failing, nothing is judged for that parcel.
   */
  async judgeRemovals(): Promise<number> {
    const cutoff = addMs(this.clock.now(), -REMOVAL_GRACE_MS).toISOString();
    const candidates = await this.db
      .selectFrom("parcels")
      .select("parcels.id")
      .where("parcels.delivered", "=", 0)
      .where("parcels.removed_at", "is", null)
      .where("parcels.archived_at", "is", null)
      .where("parcels.manual_status", "is", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("parcel_sources")
            .select("parcel_sources.parcel_id")
            .whereRef("parcel_sources.parcel_id", "=", "parcels.id"),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("parcel_sources")
              .innerJoin("sources", "sources.id", "parcel_sources.source_id")
              .select("parcel_sources.parcel_id")
              .whereRef("parcel_sources.parcel_id", "=", "parcels.id")
              .where((inner) =>
                inner.or([
                  inner("parcel_sources.missing_since", "is", null),
                  inner("parcel_sources.missing_since", ">", cutoff),
                  inner("sources.state", "!=", "ok"),
                  // A tracking link never judges a removal, even one marked by an older version.
                  inner("sources.kind", "=", "tracking"),
                ]),
              ),
          ),
        ),
      )
      .execute();
    if (candidates.length === 0) {
      return 0;
    }
    await this.db.transaction().execute(async (trx) => {
      const repository = new ParcelRepository(trx, this.presentation);
      for (const { id } of candidates) {
        await trx
          .updateTable("parcels")
          .set({ removed_at: isoNow(this.clock) })
          .where("id", "=", id)
          .execute();
        const parcel = await repository.get(id);
        if (parcel !== undefined) {
          await appendEvent(trx, this.clock, {
            type: "parcel.removed",
            parcelId: id,
            payload: parcelEventPayload(parcel),
          });
        }
      }
    });
    await this.bus.notify();
    return candidates.length;
  }
}
