import { createCipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretAad } from "../../src/engine/sources.js";
import { carrierId, importLegacy } from "../../src/migrate/legacy.js";
import { createTestContext, type TestContext } from "../helpers.js";

/** The schema of the pre-rewrite app (UUID variant), as it exists in deployed databases. */
const LEGACY_DDL = `
create table orders (id text primary key, source text not null, order_number text not null, status text not null, placed_at integer, added_at integer not null, updated_at integer not null);
create table parcels (id text primary key, tracking_number text not null unique, name text, courier text, status text not null, estimated_delivery_start integer, estimated_delivery_end integer, lat real, lng real, order_id text, last_vehicle text, last_event_description text, is_manual_status integer default 0, added_at integer not null, updated_at integer not null);
create table parcel_events (id text primary key, parcel_id text not null, location text, description text not null, timestamp integer not null, lat real, lng real, vehicle text, source text);
create table credentials (id text primary key, service text not null, encrypted_data text not null, updated_at integer not null);
create table settings (key text primary key, value text not null, updated_at integer not null);
`;

function legacyEncrypt(text: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = cipher.update(text, "utf8", "hex") + cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body}`;
}

let context: TestContext;
let legacyPath: string;
const legacyKey = randomBytes(32);
const T = 1_763_000_000; // seconds

beforeEach(async () => {
  context = await createTestContext();
  legacyPath = path.join(context.dataDir, "legacy.db");
  const legacy = new SQLite(legacyPath);
  legacy.exec(LEGACY_DDL);
  legacy
    .prepare("insert into orders values (?, ?, ?, ?, ?, ?, ?)")
    .run("o1", "Amazon", "000-0000000-0000001", "shipped", T, T, T);
  const parcel = legacy.prepare(
    "insert into parcels (id, tracking_number, name, courier, status, estimated_delivery_start, estimated_delivery_end, lat, lng, order_id, last_event_description, is_manual_status, added_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  parcel.run(
    "p1",
    "00340434000000000001",
    "Socks",
    "DHL",
    "arriving",
    T + 86_400,
    T + 90_000,
    10.5,
    20.5,
    "o1",
    "On its way",
    0,
    T,
    T,
  );
  parcel.run(
    "p2",
    "H0000000000000000001",
    null,
    "Hermes",
    "delivered",
    null,
    null,
    null,
    null,
    null,
    "Delivered",
    0,
    T,
    T + 3600,
  );
  parcel.run(
    "p3",
    "00000000000001",
    "Gift",
    "DPD",
    "exception",
    null,
    null,
    null,
    null,
    null,
    null,
    1,
    T,
    T,
  );
  const event = legacy.prepare("insert into parcel_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  event.run("e1", "p1", "Hub Example", "Arrived at hub", T, 10.1, 20.1, "truck", "dhl");
  event.run("e2", "p1", null, "Driver position", T + 60, 10.2, 20.2, "van", "amazon-live");
  legacy.prepare("insert into credentials values (?, ?, ?, ?)").run(
    "c1",
    "IMAP",
    legacyEncrypt(
      JSON.stringify({
        user: "someone@example.invalid",
        password: ["made", "up"].join("-"),
        host: "imap.example.invalid",
        port: 993,
        tls: true,
      }),
      legacyKey,
    ),
    T,
  );
  legacy
    .prepare("insert into credentials values (?, ?, ?, ?)")
    .run("c2", "Amazon", legacyEncrypt("{}", legacyKey), T);
  legacy.prepare("insert into settings values (?, ?, ?)").run("home_zip", '"00000"', T);
  legacy.close();
});
afterEach(async () => {
  await context.close();
});

/** `null` means "no old key"; omitting the argument uses the right one. */
function run(dryRun: boolean, legacyKeyHex: string | null = legacyKey.toString("hex")) {
  return importLegacy({
    legacyPath,
    db: context.services.db,
    secrets: context.services.secrets,
    clock: context.clock,
    legacyKeyHex: legacyKeyHex ?? undefined,
    dryRun,
  });
}

describe("legacy courier names", () => {
  it("map to plug-in ids, rules ids first", () => {
    expect(carrierId("DHL Express")).toBe("dhl");
    expect(carrierId("Canada Post")).toBe("canadapost");
    expect(carrierId("Poczta Polska")).toBe("poczta_polska");
    expect(carrierId("BOX NOW")).toBe("box_now");
    expect(carrierId("Swiss Post")).toBe("swiss_post");
    expect(carrierId("Česká pošta")).toBe("ceska_posta");
    expect(carrierId("  ")).toBe("unknown");
  });
});

describe("legacy import", () => {
  it("reports everything in a dry run and writes nothing", async () => {
    const report = await run(true);
    expect(report).toMatchObject({
      dryRun: true,
      orders: 1,
      parcels: 3,
      events: 1,
      droppedPositionEvents: 1,
      mailboxes: 1,
      skippedCredentials: ["Amazon"],
      settingKeys: ["home_zip"],
    });
    expect(
      await context.services.parcels.repository.list({ includeArchived: true }, false),
    ).toHaveLength(0);
    expect(await context.services.sources.list()).toHaveLength(0);
  });

  it("imports parcels, orders, history and mailboxes, without positions", async () => {
    await run(false);
    const parcels = await context.services.parcels.repository.list({ includeArchived: true }, true);
    const byBarcode = new Map(parcels.map((parcel) => [parcel.barcode, parcel]));
    expect(byBarcode.get("00340434000000000001")).toMatchObject({
      carrier: "dhl",
      status: "in_transit",
      label: "Socks",
      order: { shop: "amazon", order_number: "000-0000000-0000001" },
      planned_from: new Date((T + 86_400) * 1000).toISOString(),
    });
    expect(byBarcode.get("00340434000000000001")?.history.map((entry) => entry.raw_status)).toEqual(
      ["Arrived at hub"],
    );
    expect(byBarcode.get("H0000000000000000001")).toMatchObject({
      carrier: "hermes",
      delivered: true,
      planned_from: null,
    });
    expect(byBarcode.get("00000000000001")).toMatchObject({
      carrier: "dpd",
      status: "problem",
      manual_status: "problem",
    });

    const stored = JSON.stringify(
      await context.services.db.selectFrom("parcel_events").selectAll().execute(),
    );
    expect(stored).not.toContain("10.1");

    const [mailbox] = await context.services.sources.list();
    expect(mailbox).toMatchObject({
      plugin: "imap",
      kind: "mail",
      config: { host: "imap.example.invalid", secure: true },
    });
    const row = await context.services.db
      .selectFrom("sources")
      .select(["id", "secret_blob"])
      .executeTakeFirstOrThrow();
    expect(
      context.services.secrets.decryptJson(row.secret_blob ?? Buffer.alloc(0), secretAad(row.id)),
    ).toEqual({ username: "someone@example.invalid", password: ["made", "up"].join("-") });
  });

  it("skips parcels that already exist when run twice", async () => {
    await run(false);
    const second = await run(false);
    expect(second).toMatchObject({ parcels: 0, skippedDuplicateParcels: 3 });
  });

  it("imports no credentials without the old key, and counts a wrong key as undecryptable", async () => {
    expect(await run(true, null)).toMatchObject({
      mailboxes: 0,
      skippedCredentials: ["Amazon", "IMAP"],
    });
    expect(await run(true, randomBytes(32).toString("hex"))).toMatchObject({
      mailboxes: 0,
      undecryptableCredentials: 1,
    });
  });

  it("never modifies the old database", async () => {
    await run(false);
    const legacy = new SQLite(legacyPath, { readonly: true });
    expect((legacy.prepare("select count(*) as n from parcels").get() as { n: number }).n).toBe(3);
    legacy.close();
  });
});
