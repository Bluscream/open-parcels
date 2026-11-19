import type { Kysely, Selectable } from "kysely";
import type { Database, OrderItemTable, ParcelRow } from "../db/schema.js";
import {
  effectiveDelivered,
  effectiveStatus,
  PARCEL_STATUSES,
  type HistoryEntry,
  type Item,
  type OrderItem,
  type ParcelLabelMode,
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
  /** Rows to skip, for paging through more parcels than one page holds. */
  readonly offset?: number;
}

/** Parcels per page when no limit is given. */
export const PARCEL_PAGE_DEFAULT = 500;

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
  orders: Map<string, OrderInfo>;
  listedBy: Map<string, Set<string>>;
  places: Map<string, Parcel["location"]>;
}

/** A courier position held in memory by the live tracker. */
export interface LivePosition {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracy: number | null;
  readonly positionAt: string | null;
}

/**
 * How stored data is presented to clients and events: courier positions come from memory (they
 * are never stored), and remote pictures are replaced by the server's image-proxy address.
 */
export interface Presentation {
  position(parcelId: string): LivePosition | undefined;
  imagePath(remote: string | null): string | null;
  /** The "Default parcel label" setting: how a parcel without a label is named. */
  labelMode(): ParcelLabelMode;
}

export const RAW_PRESENTATION: Presentation = {
  position: () => undefined,
  imagePath: (remote) => remote,
  labelMode: () => "tracking_number",
};

/** Item names joined, for the "Item names" label mode: at most this many characters. */
export const ITEM_LABEL_MAX = 100;

/** A parcel's name: its label, else its item names (in that mode), else the tracking code. */
export function displayName(
  label: string | null,
  barcode: string,
  items: readonly { readonly title: string }[],
  mode: ParcelLabelMode,
): string {
  if (label !== null) return label;
  if (mode === "items" && items.length > 0) {
    const names = items.map((item) => item.title.trim()).filter((title) => title !== "");
    const joined = names.join(", ");
    if (joined !== "") {
      return joined.length <= ITEM_LABEL_MAX
        ? joined
        : `${joined.slice(0, ITEM_LABEL_MAX - 1).trimEnd()}…`;
    }
  }
  return barcode;
}

type OrderItemRow = Selectable<OrderItemTable>;

interface OrderInfo {
  readonly shop: string;
  readonly order_number: string;
  readonly items: OrderItem[];
  readonly parcels: number;
}

const ON_THE_ROAD = new Set(["en_route", "next_stop"]);

/**
 * The one answer to "where is the parcel now", for every client: the courier while a live
 * session shows one, else the newest scan with coordinates, else unknown.
 */
function currentLocation(live: Live | null, lastScan: Parcel["location"]): Parcel["location"] {
  if (
    live !== null &&
    ON_THE_ROAD.has(live.state) &&
    live.latitude !== null &&
    live.longitude !== null
  ) {
    return {
      latitude: live.latitude,
      longitude: live.longitude,
      source: "courier",
      precision: "exact",
      name: null,
      address: null,
      at: live.position_at,
    };
  }
  return lastScan;
}

/** Orders with their lines and how many parcels they have. */
function buildOrders(
  orders: readonly { id: string; shop: string; order_number: string }[],
  lines: readonly OrderItemRow[],
  sizes: readonly { order_id: string | null; count: number }[],
  imagePath: (ref: string | null) => string | null,
): Map<string, OrderInfo> {
  const linesByOrder = groupBy(lines, (line) => line.order_id);
  const counts = new Map(sizes.map((size) => [size.order_id, size.count]));
  return new Map(
    orders.map((order) => [
      order.id,
      {
        shop: order.shop,
        order_number: order.order_number,
        parcels: counts.get(order.id) ?? 0,
        items: (linesByOrder.get(order.id) ?? []).map((line) => ({
          title: line.title,
          image_url: imagePath(line.image_ref),
          url: line.url,
          quantity: line.quantity,
          price: line.price,
          currency: line.currency,
          parcel_id: line.parcel_id,
        })),
      },
    ]),
  );
}

/**
 * What is in a parcel: its own item list; else the order lines linked to it; else, for an order
 * with only this parcel, every order line.
 */
function itemsOf(parcelId: string, own: Item[], order: OrderInfo | undefined): Item[] {
  if (own.length > 0 || order === undefined) return own;
  const strip = (line: OrderItem): Item => ({
    title: line.title,
    image_url: line.image_url,
    url: line.url,
    quantity: line.quantity,
    price: line.price,
    currency: line.currency,
  });
  const linked = order.items.filter((line) => line.parcel_id === parcelId);
  if (linked.length > 0) return linked.map(strip);
  return order.parcels === 1 ? order.items.map(strip) : [];
}

/** Reads parcels in the normalised shape, loading related rows in one query per table. */
export class ParcelRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly presentation: Presentation = RAW_PRESENTATION,
  ) {}

  async list(filter: ParcelFilter, withHistory: boolean): Promise<Parcel[]> {
    let query = this.db.selectFrom("parcels").selectAll();
    if (filter.includeArchived !== true) {
      query = query.where("archived_at", "is", null);
    }
    // A status set by hand wins over the carrier's, for filters as everywhere else.
    if (filter.active !== undefined) {
      const isDelivered = filter.active ? 0 : 1;
      query = query.where((eb) =>
        eb.or([
          eb.and([eb("manual_status", "is", null), eb("delivered", "=", isDelivered)]),
          eb.and([
            eb("manual_status", "is not", null),
            filter.active
              ? eb("manual_status", "!=", "delivered")
              : eb("manual_status", "=", "delivered"),
          ]),
        ]),
      );
    }
    if (filter.status !== undefined) {
      const status = filter.status;
      query = query.where((eb) =>
        eb.or([
          eb.and([eb("manual_status", "is", null), eb("status", "=", status)]),
          eb("manual_status", "=", status),
        ]),
      );
    }
    if (filter.carrier !== undefined) {
      query = query.where("carrier", "=", filter.carrier);
    }
    // The id breaks ties, so pages never repeat or skip a parcel changed at the same instant.
    const rows = await query
      .orderBy("updated_at", "desc")
      .orderBy("id", "asc")
      .limit(filter.limit ?? PARCEL_PAGE_DEFAULT)
      .offset(filter.offset ?? 0)
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
        listedBy: new Map(),
        places: new Map(),
      };
    }
    const [events, placed, items, live, sources, orders, orderItems, orderSizes] =
      await Promise.all([
        withHistory
          ? this.db
              .selectFrom("parcel_events")
              .selectAll()
              .where("parcel_id", "in", ids)
              .orderBy("at")
              .execute()
          : Promise.resolve([]),
        // Only the scans with a position: the parcel's place, also when the history is not loaded.
        this.db
          .selectFrom("parcel_events")
          .select(["parcel_id", "at", "location_text", "latitude", "longitude"])
          .where("parcel_id", "in", ids)
          .where("latitude", "is not", null)
          .where("longitude", "is not", null)
          .orderBy("at")
          .execute(),
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
            "parcel_sources.missing_since",
            "sources.plugin",
            "sources.label",
            "sources.kind",
          ])
          .orderBy("sources.created_at")
          .where("parcel_sources.parcel_id", "in", ids)
          .execute(),
        orderIds.length === 0
          ? Promise.resolve([])
          : this.db
              .selectFrom("orders")
              .select(["id", "shop", "order_number"])
              .where("id", "in", orderIds)
              .execute(),
        orderIds.length === 0
          ? Promise.resolve([])
          : this.db
              .selectFrom("order_items")
              .selectAll()
              .where("order_id", "in", orderIds)
              .orderBy("order_id")
              .orderBy("position")
              .execute(),
        orderIds.length === 0
          ? Promise.resolve([])
          : this.db
              .selectFrom("parcels")
              .select((eb) => ["order_id", eb.fn.countAll<number>().as("count")])
              .where("order_id", "in", orderIds)
              .groupBy("order_id")
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
          latitude: event.latitude,
          longitude: event.longitude,
        })),
      );
    }
    const places = new Map<string, Parcel["location"]>();
    for (const event of placed) {
      // Ordered by time, so the last one written per parcel is its latest.
      if (event.latitude !== null && event.longitude !== null) {
        places.set(event.parcel_id, {
          latitude: event.latitude,
          longitude: event.longitude,
          source: "event",
          precision: "exact",
          name: event.location_text,
          address: null,
          at: event.at,
        });
      }
    }
    const itemMap = new Map<string, Item[]>();
    for (const [parcelId, list] of groupBy(items, (item) => item.parcel_id)) {
      itemMap.set(
        parcelId,
        list.map((item) => ({
          title: item.title,
          image_url: this.presentation.imagePath(item.image_ref),
          url: item.url,
          quantity: item.quantity,
          price: item.price,
          currency: item.currency,
        })),
      );
    }
    const liveMap = new Map<string, Live>(
      live.map((row) => {
        const position = this.presentation.position(row.parcel_id);
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
    const listedBy = new Map<string, Set<string>>();
    for (const [parcelId, list] of groupBy(sources, (source) => source.parcel_id)) {
      sourceMap.set(
        parcelId,
        list.map((source) => ({
          source_id: source.source_id,
          plugin: source.plugin,
          label: source.label,
          kind: source.kind,
          role: source.role,
          last_seen_at: source.last_seen_at,
        })),
      );
      // Account and shop sources that currently list the parcel, by plug-in: proof that the
      // carrier knows the code even when its public tracking does not return it.
      listedBy.set(
        parcelId,
        new Set(
          list
            .filter(
              (source) =>
                (source.kind === "account" || source.kind === "shop") &&
                source.role !== "mail" &&
                source.missing_since === null,
            )
            .map((source) => source.plugin),
        ),
      );
    }
    const orderMap = buildOrders(orders, orderItems, orderSizes, (ref) =>
      this.presentation.imagePath(ref),
    );

    return {
      history,
      items: itemMap,
      live: liveMap,
      sources: sourceMap,
      orders: orderMap,
      listedBy,
      places,
    };
  }

  #toParcel(row: ParcelRow, related: Related): Parcel {
    const order = row.order_id === null ? undefined : related.orders.get(row.order_id);
    const items = itemsOf(row.id, related.items.get(row.id) ?? [], order);
    const carrierStatus = asStatus(row.status) ?? "unknown";
    const manual = asStatus(row.manual_status);
    const carrierDelivered = row.delivered === 1;
    const listed = related.listedBy.get(row.id)?.has(row.carrier) === true;
    return {
      carrier: row.carrier,
      barcode: row.barcode,
      sender: row.sender,
      receiver: row.receiver,
      status: effectiveStatus({ status: carrierStatus, manual_status: manual }),
      raw_status: row.raw_status,
      delivered: effectiveDelivered(carrierDelivered, manual),
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
      display_name: displayName(row.label, row.barcode, items, this.presentation.labelMode()),
      manual_status: manual,
      carrier_status: carrierStatus,
      carrier_delivered: carrierDelivered,
      archived_at: row.archived_at,
      items,
      live: related.live.get(row.id) ?? null,
      location: currentLocation(
        related.live.get(row.id) ?? null,
        related.places.get(row.id) ?? null,
      ),
      last_scan: related.places.get(row.id) ?? null,
      order:
        order === undefined
          ? null
          : { shop: order.shop, order_number: order.order_number, items: order.items },
      sources: related.sources.get(row.id) ?? [],
      // Another source of the same carrier (an account) listing the parcel means the carrier
      // found it, whatever its public tracking answered. It has been found since the app first
      // saw it, which is when a source first listed it.
      lookup:
        row.lookup_state === "not_found" && listed
          ? { state: "found", since: row.first_seen_at, checked_at: row.lookup_checked_at }
          : {
              state: row.lookup_state,
              since: row.lookup_since ?? (row.lookup_state === "found" ? row.first_seen_at : null),
              checked_at: row.lookup_checked_at,
            },
      first_seen_at: row.first_seen_at,
      updated_at: row.updated_at,
    };
  }
}
