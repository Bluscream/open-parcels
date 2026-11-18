import type { Kysely } from "kysely";
import type { Database, ParcelRow } from "../db/schema.js";
import {
  PARCEL_STATUSES,
  type HistoryEntry,
  type Item,
  type Live,
  type Parcel,
  type ParcelStatus,
} from "../domain/parcel.js";

export interface ParcelFilter {
  readonly active?: boolean;
  readonly status?: ParcelStatus;
  readonly carrier?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

function asStatus(value: string | null): ParcelStatus | null {
  return value !== null && PARCEL_STATUSES.includes(value as ParcelStatus)
    ? (value as ParcelStatus)
    : null;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id);
    if (list === undefined) {
      groups.set(id, [row]);
    } else {
      list.push(row);
    }
  }
  return groups;
}

interface Related {
  history: Map<string, HistoryEntry[]>;
  items: Map<string, Item[]>;
  live: Map<string, Live>;
  sources: Map<string, Parcel["sources"]>;
  orders: Map<string, Parcel["order"]>;
}

/** Reads parcels in the normalised shape, loading related rows in one query per table. */
/** A courier position held in memory by the live tracker. */
export interface LivePosition {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracy: number | null;
  readonly positionAt: string | null;
}

export type PositionLookup = (parcelId: string) => LivePosition | undefined;

export class ParcelRepository {
  constructor(
    private readonly db: Kysely<Database>,
    /** Courier positions are never stored; the live tracker supplies them from memory. */
    private readonly positions: PositionLookup = () => undefined,
  ) {}

  async list(filter: ParcelFilter, withHistory: boolean): Promise<Parcel[]> {
    let query = this.db.selectFrom("parcels").selectAll();
    if (filter.includeArchived !== true) {
      query = query.where("archived_at", "is", null);
    }
    if (filter.active !== undefined) {
      query = query.where("delivered", "=", filter.active ? 0 : 1);
    }
    if (filter.status !== undefined) {
      query = query.where("status", "=", filter.status);
    }
    if (filter.carrier !== undefined) {
      query = query.where("carrier", "=", filter.carrier);
    }
    const rows = await query
      .orderBy("updated_at", "desc")
      .limit(filter.limit ?? 500)
      .execute();
    const related = await this.#loadRelated(rows, withHistory);
    return rows.map((row) => this.#toParcel(row, related));
  }

  async get(id: string): Promise<Parcel | undefined> {
    const row = await this.db
      .selectFrom("parcels")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const related = await this.#loadRelated([row], true);
    return this.#toParcel(row, related);
  }

  async findIdByBarcode(carrier: string, barcode: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("parcels")
      .select("id")
      .where("carrier", "=", carrier)
      .where("barcode", "=", barcode)
      .executeTakeFirst();
    return row?.id;
  }

  async #loadRelated(rows: readonly ParcelRow[], withHistory: boolean): Promise<Related> {
    const ids = rows.map((row) => row.id);
    const orderIds = rows.map((row) => row.order_id).filter((id): id is string => id !== null);
    if (ids.length === 0) {
      return {
        history: new Map(),
        items: new Map(),
        live: new Map(),
        sources: new Map(),
        orders: new Map(),
      };
    }
    const [events, items, live, sources, orders] = await Promise.all([
      withHistory
        ? this.db
            .selectFrom("parcel_events")
            .selectAll()
            .where("parcel_id", "in", ids)
            .orderBy("at")
            .execute()
        : Promise.resolve([]),
      this.db
        .selectFrom("items")
        .selectAll()
        .where("parcel_id", "in", ids)
        .orderBy("position")
        .execute(),
      this.db.selectFrom("live_state").selectAll().where("parcel_id", "in", ids).execute(),
      this.db
        .selectFrom("parcel_sources")
        .innerJoin("sources", "sources.id", "parcel_sources.source_id")
        .select([
          "parcel_sources.parcel_id",
          "parcel_sources.source_id",
          "parcel_sources.role",
          "parcel_sources.last_seen_at",
          "sources.plugin",
        ])
        .where("parcel_sources.parcel_id", "in", ids)
        .execute(),
      orderIds.length === 0
        ? Promise.resolve([])
        : this.db
            .selectFrom("orders")
            .select(["id", "shop", "order_number"])
            .where("id", "in", orderIds)
            .execute(),
    ]);
    const history = new Map<string, HistoryEntry[]>();
    for (const [parcelId, list] of groupBy(events, (event) => event.parcel_id)) {
      history.set(
        parcelId,
        list.map((event) => ({
          timestamp: event.at,
          status: asStatus(event.status),
          raw_status: event.raw_status,
          location: event.location_text,
        })),
      );
    }
    const itemMap = new Map<string, Item[]>();
    for (const [parcelId, list] of groupBy(items, (item) => item.parcel_id)) {
      itemMap.set(
        parcelId,
        list.map((item) => ({
          title: item.title,
          image_url: item.image_ref,
          url: item.url,
          quantity: item.quantity,
        })),
      );
    }
    const liveMap = new Map<string, Live>(
      live.map((row) => {
        const position = this.positions(row.parcel_id);
        return [
          row.parcel_id,
          {
            state: row.state,
            stops_away: row.stops_away,
            latitude: position?.latitude ?? null,
            longitude: position?.longitude ?? null,
            accuracy: position?.accuracy ?? null,
            position_at: position?.positionAt ?? row.position_at,
            message: row.message,
            updated_at: row.updated_at,
          },
        ];
      }),
    );
    const sourceMap = new Map<string, Parcel["sources"]>();
    for (const [parcelId, list] of groupBy(sources, (source) => source.parcel_id)) {
      sourceMap.set(
        parcelId,
        list.map((source) => ({
          source_id: source.source_id,
          plugin: source.plugin,
          role: source.role,
          last_seen_at: source.last_seen_at,
        })),
      );
    }
    const orderMap = new Map<string, Parcel["order"]>(
      orders.map((order) => [order.id, { shop: order.shop, order_number: order.order_number }]),
    );
    return { history, items: itemMap, live: liveMap, sources: sourceMap, orders: orderMap };
  }

  #toParcel(row: ParcelRow, related: Related): Parcel {
    return {
      carrier: row.carrier,
      barcode: row.barcode,
      sender: row.sender,
      receiver: row.receiver,
      status: asStatus(row.status) ?? "unknown",
      raw_status: row.raw_status,
      delivered: row.delivered === 1,
      delivered_at: row.delivered_at,
      planned_from: row.planned_from,
      planned_to: row.planned_to,
      pickup: row.pickup === 1,
      pickup_point: row.pickup_point,
      history: related.history.get(row.id) ?? [],
      url: row.url,
      id: row.id,
      direction: row.direction,
      label: row.label,
      manual_status: asStatus(row.manual_status),
      items: related.items.get(row.id) ?? [],
      live: related.live.get(row.id) ?? null,
      location: null,
      order: row.order_id === null ? null : (related.orders.get(row.order_id) ?? null),
      sources: related.sources.get(row.id) ?? [],
      first_seen_at: row.first_seen_at,
      updated_at: row.updated_at,
    };
  }
}
