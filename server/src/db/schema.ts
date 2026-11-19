import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/**
 * Row types for Kysely. Conventions:
 * - timestamps are ISO-8601 UTC strings (`...Z`);
 * - booleans are 0/1 integers, as SQLite has no boolean type;
 * - JSON columns are TEXT holding serialised JSON;
 * - encrypted columns are BLOBs produced by SecretBox.
 */
type Bool = 0 | 1;
type Timestamp = string;

export interface OwnerTable {
  id: ColumnType<1, 1, never>;
  password_hash: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionTable {
  /** SHA-256 of the session cookie value; the raw value is never stored. */
  id_hash: string;
  csrf_token: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  user_agent: string | null;
}

export interface ApiTokenTable {
  id: string;
  name: string;
  /** SHA-256 of the token; the raw value is shown once at creation. */
  token_hash: string;
  /** JSON array of scopes. */
  scopes: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
  expires_at: Timestamp | null;
}

export interface SettingTable {
  key: string;
  /** JSON value. */
  value: string;
  updated_at: Timestamp;
}

export interface SourceTable {
  id: string;
  plugin: string;
  kind: "account" | "tracking" | "shop" | "mail";
  label: string;
  /** JSON, non-secret plug-in configuration. */
  config: string;
  secret_blob: Buffer | null;
  session_blob: Buffer | null;
  /** `idle`: the last run deliberately did nothing; `state_detail` says why. */
  state: "ok" | "idle" | "needs_sign_in" | "error" | "disabled";
  state_detail: string | null;
  consecutive_failures: Generated<number>;
  backoff_until: Timestamp | null;
  next_run_at: Timestamp | null;
  last_run_at: Timestamp | null;
  last_ok_at: Timestamp | null;
  /** 1 when the app made this keyless tracking source on its own; see migration 0006. */
  auto_created: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderTable {
  id: string;
  shop: string;
  order_number: string;
  placed_at: Timestamp | null;
  status: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ParcelTable {
  id: string;
  carrier: string;
  barcode: string;
  direction: "incoming" | "outgoing";
  status: string;
  raw_status: string | null;
  delivered: Bool;
  delivered_at: Timestamp | null;
  planned_from: Timestamp | null;
  planned_to: Timestamp | null;
  pickup: Bool;
  pickup_point: string | null;
  url: string | null;
  sender: string | null;
  receiver: string | null;
  weight_kg: number | null;
  /** JSON {length, width, height} in cm, or null. */
  dimensions: string | null;
  label: string | null;
  order_id: string | null;
  manual_status: string | null;
  manual_until: Timestamp | null;
  /** Time of the newest scan that set `status`; null when no scan carried a time. */
  status_at: ColumnType<Timestamp | null, Timestamp | null | undefined>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  updated_at: Timestamp;
  removed_at: Timestamp | null;
  archived_at: Timestamp | null;
  /** Why the app archived the parcel on its own; null for retention or a user's archive. */
  archive_reason: ColumnType<string | null, string | null | undefined>;
  /** What a carrier last said about the code: pending (never answered), found or not_found. */
  lookup_state: ColumnType<
    "pending" | "found" | "not_found",
    "pending" | "found" | "not_found" | undefined
  >;
  /** When the current lookup state began. */
  lookup_since: ColumnType<Timestamp | null, Timestamp | null | undefined>;
  /** When a carrier was last asked about the code. */
  lookup_checked_at: ColumnType<Timestamp | null, Timestamp | null | undefined>;
}

export interface ParcelSourceTable {
  parcel_id: string;
  source_id: string;
  external_ref: string | null;
  role: "primary" | "handoff" | "mail";
  last_seen_at: Timestamp;
  /** First time a complete listing of this source lacked the parcel; null while it is listed. */
  missing_since: ColumnType<Timestamp | null, Timestamp | null | undefined>;
}

export interface ParcelEventTable {
  id: Generated<number>;
  parcel_id: string;
  source_id: string | null;
  at: Timestamp;
  status: string | null;
  raw_status: string;
  location_text: string | null;
  /** Where the scan happened, when the carrier says; both set or both null. */
  latitude: ColumnType<number | null, number | null | undefined>;
  longitude: ColumnType<number | null, number | null | undefined>;
  /** Hash of (at, raw_status, location) so a re-fetched history never duplicates entries. */
  fingerprint: string;
}

export interface ParcelRawTable {
  parcel_id: string;
  source_id: string;
  fetched_at: Timestamp;
  payload: string;
}

export interface ItemTable {
  id: Generated<number>;
  parcel_id: string;
  position: number;
  title: string;
  image_ref: string | null;
  url: string | null;
  external_id: string | null;
  quantity: number | null;
  price: number | null;
  currency: string | null;
}

/** What was ordered; `parcel_id` once it is known which parcel carries it. */
export interface OrderItemTable {
  id: Generated<number>;
  order_id: string;
  position: number;
  title: string;
  image_ref: string | null;
  url: string | null;
  external_id: string | null;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  parcel_id: string | null;
}

export interface LiveStateTable {
  parcel_id: string;
  state: "en_route" | "next_stop" | "delivered" | "ended";
  stops_away: number | null;
  message: string | null;
  position_at: Timestamp | null;
  updated_at: Timestamp;
}

export interface PlaceTable {
  key: string;
  latitude: number | null;
  longitude: number | null;
  precision: "exact" | "street" | "area" | null;
  resolved_at: Timestamp | null;
  missed_at: Timestamp | null;
}

export interface OutboxTable {
  seq: Generated<number>;
  type: string;
  parcel_id: string | null;
  payload: string;
  created_at: Timestamp;
}

export interface UnknownVocabTable {
  plugin: string;
  kind: string;
  key: string;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  count: number;
}

export interface ImageCacheTable {
  id: string;
  source_url: string;
  content_type: string | null;
  bytes: number | null;
  fetched_at: Timestamp | null;
  expires_at: Timestamp | null;
}

export interface SignInAttemptTable {
  id: string;
  source_id: string;
  flow: string;
  /** Encrypted JSON {state, step}; the AAD binds it to the attempt and the source. */
  blob: Buffer;
  failures: Generated<number>;
  created_at: Timestamp;
  expires_at: Timestamp;
  /** Set while the step waits for an approval: polls before this are refused. */
  poll_not_before: Timestamp | null;
}

export interface Database {
  owner: OwnerTable;
  sessions: SessionTable;
  api_tokens: ApiTokenTable;
  settings: SettingTable;
  sources: SourceTable;
  orders: OrderTable;
  parcels: ParcelTable;
  parcel_sources: ParcelSourceTable;
  parcel_events: ParcelEventTable;
  order_items: OrderItemTable;
  parcel_raw: ParcelRawTable;
  items: ItemTable;
  live_state: LiveStateTable;
  places: PlaceTable;
  outbox: OutboxTable;
  unknown_vocab: UnknownVocabTable;
  image_cache: ImageCacheTable;
  sign_in_attempts: SignInAttemptTable;
}

export type ParcelRow = Selectable<ParcelTable>;
export type NewParcelRow = Insertable<ParcelTable>;
export type ParcelUpdate = Updateable<ParcelTable>;
export type SourceRow = Selectable<SourceTable>;
export type ApiTokenRow = Selectable<ApiTokenTable>;
export type OutboxRow = Selectable<OutboxTable>;
