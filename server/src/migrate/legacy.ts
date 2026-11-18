import { createDecipheriv } from "node:crypto";
import SQLite from "better-sqlite3";
import type { Kysely, Transaction } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database } from "../db/schema.js";
import type { ParcelStatus } from "../domain/parcel.js";
import { secretAad } from "../engine/sources.js";
import { MAIL_PLUGIN } from "../mail/types.js";

/** Statuses of the pre-rewrite app, mapped to the canonical list. */
const STATUS_MAP: Readonly<Record<string, ParcelStatus>> = {
  ordered: "registered",
  pending: "registered",
  registered: "registered",
  sent: "in_transit",
  shipped: "in_transit",
  dispatched: "in_transit",
  in_transit: "in_transit",
  // "arriving" covered both "today" and later days; the first poll after the import corrects it.
  arriving: "in_transit",
  out_for_delivery: "out_for_delivery",
  ready_for_pickup: "at_pickup_point",
  delivered: "delivered",
  exception: "problem",
  failed: "problem",
  return: "returning",
  returned: "returning",
  unknown: "unknown",
};

export interface LegacyReport {
  readonly dryRun: boolean;
  readonly orders: number;
  readonly parcels: number;
  readonly skippedDuplicateParcels: number;
  readonly events: number;
  readonly droppedPositionEvents: number;
  readonly mailboxes: number;
  /** Services whose stored credentials were not imported (e.g. Amazon: sign in again). */
  readonly skippedCredentials: readonly string[];
  readonly undecryptableCredentials: number;
  /** Setting keys found in the old database; their values are not carried over. */
  readonly settingKeys: readonly string[];
  readonly statuses: Readonly<Record<string, number>>;
}

export interface LegacyImportOptions {
  readonly legacyPath: string;
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  /** The old ENCRYPTION_KEY (64 hex characters); without it no credentials are imported. */
  readonly legacyKeyHex: string | undefined;
  readonly dryRun: boolean;
}

class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
}

type Row = Record<string, unknown>;

/** Old timestamps are Unix seconds (milliseconds in a few rows); returns ISO or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value > 1e12 ? value : value * 1000).toISOString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function carrierId(courier: unknown): string {
  const name = text(courier)?.toLowerCase() ?? "unknown";
  return name.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function decryptLegacy(encrypted: string, key: Buffer): string {
  const [iv, tag, body] = encrypted.split(":");
  if (iv === undefined || tag === undefined || body === undefined) {
    throw new Error("Unknown credential format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(body, "hex", "utf8") + decipher.final("utf8");
}

function columns(legacy: SQLite.Database, table: string): Set<string> {
  const info = legacy.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  return new Set(info.map((column) => column.name));
}

function readAll(legacy: SQLite.Database, table: string): Row[] {
  return columns(legacy, table).size === 0
    ? []
    : (legacy.prepare(`select * from ${table}`).all() as Row[]);
}

interface Counters {
  orders: number;
  parcels: number;
  skippedDuplicateParcels: number;
  events: number;
  droppedPositionEvents: number;
  mailboxes: number;
  undecryptableCredentials: number;
  statuses: Record<string, number>;
}

async function importOrders(
  trx: Transaction<Database>,
  rows: readonly Row[],
  now: string,
  counters: Counters,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const orderNumber = text(row["order_number"]);
    if (orderNumber === null) {
      continue;
    }
    const shop = text(row["source"])?.toLowerCase() ?? "unknown";
    const existing = await trx
      .selectFrom("orders")
      .select("id")
      .where("shop", "=", shop)
      .where("order_number", "=", orderNumber)
      .executeTakeFirst();
    const id = existing?.id ?? crypto.randomUUID();
    if (existing === undefined) {
      await trx
        .insertInto("orders")
        .values({
          id,
          shop,
          order_number: orderNumber,
          placed_at: toIso(row["placed_at"]),
          status: text(row["status"]),
          created_at: toIso(row["added_at"]) ?? now,
          updated_at: toIso(row["updated_at"]) ?? now,
        })
        .execute();
      counters.orders += 1;
    }
    ids.set(String(row["id"]), id);
  }
  return ids;
}

async function importParcels(
  trx: Transaction<Database>,
  rows: readonly Row[],
  orderIds: ReadonlyMap<string, string>,
  now: string,
  counters: Counters,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const barcode = text(row["tracking_number"]);
    if (barcode === null) {
      continue;
    }
    const carrier = carrierId(row["courier"]);
    const oldStatus = text(row["status"])?.toLowerCase() ?? "unknown";
    const status = STATUS_MAP[oldStatus] ?? "unknown";
    counters.statuses[`${oldStatus} → ${status}`] =
      (counters.statuses[`${oldStatus} → ${status}`] ?? 0) + 1;
    const existing = await trx
      .selectFrom("parcels")
      .select("id")
      .where("carrier", "=", carrier)
      .where("barcode", "=", barcode)
      .executeTakeFirst();
    if (existing !== undefined) {
      counters.skippedDuplicateParcels += 1;
      continue;
    }
    const id = crypto.randomUUID();
    const delivered = status === "delivered";
    const updatedAt = toIso(row["updated_at"]) ?? now;
    await trx
      .insertInto("parcels")
      .values({
        id,
        carrier,
        barcode,
        direction: "incoming",
        status,
        raw_status: text(row["last_event_description"]),
        delivered: delivered ? 1 : 0,
        delivered_at: delivered ? updatedAt : null,
        planned_from: delivered ? null : toIso(row["estimated_delivery_start"]),
        planned_to: delivered ? null : toIso(row["estimated_delivery_end"]),
        pickup: 0,
        label: text(row["name"]),
        order_id: orderIds.get(String(row["order_id"])) ?? null,
        // A status the user set by hand stays theirs.
        manual_status: row["is_manual_status"] === 1 ? status : null,
        first_seen_at: toIso(row["added_at"]) ?? now,
        last_seen_at: updatedAt,
        updated_at: updatedAt,
      })
      .execute();
    ids.set(String(row["id"]), id);
    counters.parcels += 1;
  }
  return ids;
}

async function importEvents(
  trx: Transaction<Database>,
  rows: readonly Row[],
  parcelIds: ReadonlyMap<string, string>,
  counters: Counters,
): Promise<void> {
  for (const row of rows) {
    const parcelId = parcelIds.get(String(row["parcel_id"]));
    const at = toIso(row["timestamp"]);
    const description = text(row["description"]);
    // Rows written by the old live scraper were courier positions; positions are never history.
    if (/live/i.test(text(row["source"]) ?? "")) {
      counters.droppedPositionEvents += 1;
      continue;
    }
    if (parcelId === undefined || at === null || description === null) {
      continue;
    }
    const location = text(row["location"]);
    await trx
      .insertInto("parcel_events")
      .values({
        parcel_id: parcelId,
        source_id: null,
        at,
        status: null,
        raw_status: description,
        location_text: location,
        fingerprint: `legacy-${String(row["id"])}`,
      })
      .onConflict((oc) => oc.columns(["parcel_id", "fingerprint"]).doNothing())
      .execute();
    counters.events += 1;
  }
}

interface ImportCredentials {
  readonly trx: Transaction<Database>;
  readonly rows: readonly Row[];
  readonly key: Buffer | undefined;
  readonly secrets: SecretBox;
  readonly now: string;
}

async function importCredentials(
  input: ImportCredentials,
  counters: Counters,
  skipped: Set<string>,
): Promise<void> {
  for (const row of input.rows) {
    const service = text(row["service"]) ?? "unknown";
    const encrypted = text(row["encrypted_data"]);
    if (service.toUpperCase() !== "IMAP" || input.key === undefined || encrypted === null) {
      skipped.add(service);
      continue;
    }
    let imap: { user?: string; password?: string; host?: string; port?: number; tls?: boolean };
    try {
      imap = JSON.parse(decryptLegacy(encrypted, input.key)) as typeof imap;
    } catch {
      // Wrong key or damaged data: counted in the report; the mailbox can be added by hand.
      counters.undecryptableCredentials += 1;
      continue;
    }
    if (imap.host === undefined || imap.user === undefined || imap.password === undefined) {
      skipped.add(service);
      continue;
    }
    const id = crypto.randomUUID();
    await input.trx
      .insertInto("sources")
      .values({
        id,
        plugin: MAIL_PLUGIN,
        kind: "mail",
        label: `Mailbox ${imap.host}`,
        config: JSON.stringify({
          host: imap.host,
          port: imap.port ?? 993,
          secure: imap.tls !== false,
          folders: ["INBOX"],
          initialDays: 30,
        }),
        secret_blob: input.secrets.encryptJson(
          { username: imap.user, password: imap.password },
          secretAad(id),
        ),
        session_blob: null,
        state: "ok",
        state_detail: null,
        next_run_at: null,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    counters.mailboxes += 1;
  }
}

/**
 * Imports the pre-rewrite database. The old file is opened read-only and never changed. A dry run
 * performs the whole import inside a transaction and rolls it back, so it validates everything.
 */
export async function importLegacy(options: LegacyImportOptions): Promise<LegacyReport> {
  const legacy = new SQLite(options.legacyPath, { readonly: true, fileMustExist: true });
  const key =
    options.legacyKeyHex === undefined ? undefined : Buffer.from(options.legacyKeyHex, "hex");
  if (key !== undefined && key.length !== 32) {
    legacy.close();
    throw new Error("The old encryption key must be 64 hex characters.");
  }
  const counters: Counters = {
    orders: 0,
    parcels: 0,
    skippedDuplicateParcels: 0,
    events: 0,
    droppedPositionEvents: 0,
    mailboxes: 0,
    undecryptableCredentials: 0,
    statuses: {},
  };
  const skipped = new Set<string>();
  const settingKeys = readAll(legacy, "settings").map((row) => String(row["key"]));
  try {
    await options.db.transaction().execute(async (trx) => {
      const now = isoNow(options.clock);
      const orderIds = await importOrders(trx, readAll(legacy, "orders"), now, counters);
      const parcelIds = await importParcels(
        trx,
        readAll(legacy, "parcels"),
        orderIds,
        now,
        counters,
      );
      await importEvents(trx, readAll(legacy, "parcel_events"), parcelIds, counters);
      await importCredentials(
        { trx, rows: readAll(legacy, "credentials"), key, secrets: options.secrets, now },
        counters,
        skipped,
      );
      if (options.dryRun) {
        throw new DryRunRollback("Dry run: rolling back.");
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      throw error;
    }
  } finally {
    legacy.close();
  }
  return {
    dryRun: options.dryRun,
    ...counters,
    skippedCredentials: [...skipped].sort(),
    settingKeys: settingKeys.sort(),
  };
}
