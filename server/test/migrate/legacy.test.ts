import { createCipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import SQLite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretAad } from "../../src/engine/sources.js";
import { carrierId, importLegacy, resolveLegacyCarrier } from "../../src/migrate/legacy.js";
import { parseLegacyImap } from "../../src/migrate/legacy-imap.js";
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
    expect(carrierId("china")).toBe("unknown");
    expect(carrierId("17track")).toBe("unknown");
  });

  const resolve = (courier: unknown, barcode: string, shop: string | null = null) =>
    resolveLegacyCarrier({ courier, barcode, shop });

  it("keep a named courier a plug-in tracks", () => {
    expect(resolve("DHL", "XX")).toBe("dhl");
    expect(resolve("Cainiao", "XX")).toBe("cainiao");
  });

  it("detect the carrier from the code when the courier is empty or generic", () => {
    expect(resolve(null, "1Z999AA10123456784")).toBe("ups");
    expect(resolve("unknown", "1Z999AA10123456784")).toBe("ups");
    expect(resolve("17track", "1Z999AA10123456784")).toBe("ups");
    // A China Post S10 code: no China Post plug-in, so Cainiao's tracker follows it.
    expect(resolve("china", "RR123456785CN")).toBe("cainiao");
    expect(resolve("China Post", "RR123456785CN")).toBe("cainiao");
  });

  it("fall back to the shop's network, then the name, then unknown", () => {
    expect(resolve("17track", "NOFORMAT0001", "AliExpress")).toBe("cainiao");
    expect(resolve("", "NOFORMAT0001", "Amazon")).toBe("amazon");
    expect(resolve("china", "NOFORMAT0001")).toBe("cainiao");
    expect(resolve("Some Local Courier", "NOFORMAT0001")).toBe("some_local_courier");
    expect(resolve("17track", "NOFORMAT0001")).toBe("unknown");
    expect(resolve(null, "NOFORMAT0001", "Otto")).toBe("unknown");
  });
});

describe("legacy IMAP credentials", () => {
  const pass = ["made", "up"].join("-");

  it("read the usual field names and nestings", () => {
    expect(
      parseLegacyImap({ host: "imap.example.invalid", user: "a@example.invalid", pass }),
    ).toMatchObject({
      ok: true,
      config: { host: "imap.example.invalid", port: 993, secure: true, folders: ["INBOX"] },
      secret: { username: "a@example.invalid", password: pass },
    });
    expect(
      parseLegacyImap({
        imap: { server: "imap.example.invalid", port: "143", tls: "false" },
        auth: { username: "a@example.invalid", password: pass },
        folders: "INBOX, Shopping",
      }),
    ).toMatchObject({
      ok: true,
      config: { port: 143, secure: false, folders: ["INBOX", "Shopping"] },
    });
    expect(
      parseLegacyImap({
        imapHost: "imap.example.invalid",
        email: "a@example.invalid",
        pass,
        ssl: 1,
      }),
    ).toMatchObject({ ok: true, config: { secure: true } });
  });

  it("take the host from old settings when the credential lacks it", () => {
    expect(
      parseLegacyImap(
        { user: "a@example.invalid", pass },
        { host: "imap.example.invalid", port: 993 },
      ),
    ).toMatchObject({ ok: true, config: { host: "imap.example.invalid" } });
  });

  it("say which fields are missing, never their values", () => {
    const result = parseLegacyImap({ user: "a@example.invalid", pass });
    expect(result).toEqual({
      ok: false,
      reason: "The IMAP credential has no host (fields present: pass, user).",
    });
    expect(parseLegacyImap("text")).toMatchObject({ ok: false });
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
      skippedCredentials: [
        { service: "Amazon", reason: expect.stringContaining("device") as string },
      ],
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

    const mailbox = (await context.services.sources.list()).find((s) => s.kind === "mail");
    expect(mailbox).toMatchObject({
      plugin: "imap",
      kind: "mail",
      config: { host: "imap.example.invalid", secure: true },
    });
    const row = await context.services.db
      .selectFrom("sources")
      .select(["id", "secret_blob"])
      .where("kind", "=", "mail")
      .executeTakeFirstOrThrow();
    expect(
      context.services.secrets.decryptJson(row.secret_blob ?? Buffer.alloc(0), secretAad(row.id)),
    ).toEqual({ username: "someone@example.invalid", password: ["made", "up"].join("-") });
  });

  it("resolves generic couriers, links active parcels and reads other IMAP shapes", async () => {
    const legacy = new SQLite(legacyPath);
    legacy
      .prepare("insert into orders values (?, ?, ?, ?, ?, ?, ?)")
      .run("o2", "AliExpress", "0000000000000002", "shipped", T, T, T);
    const parcel = legacy.prepare(
      "insert into parcels (id, tracking_number, courier, status, order_id, added_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    );
    parcel.run("p4", "RR123456785CN", "china", "shipped", null, T, T);
    parcel.run("p5", "NOFORMAT0002", "17track", "shipped", "o2", T, T);
    parcel.run("p6", "NOFORMAT0003", null, "pending", null, T, T);
    legacy.prepare("delete from credentials where id = 'c1'").run();
    legacy.prepare("insert into credentials values (?, ?, ?, ?)").run(
      "c3",
      "imap",
      legacyEncrypt(
        JSON.stringify({
          auth: { username: "b@example.invalid", pass: ["made", "up"].join("-") },
        }),
        legacyKey,
      ),
      T,
    );
    legacy
      .prepare("insert into settings values (?, ?, ?)")
      .run("imap_host", '"imap.example.invalid"', T);
    legacy
      .prepare("insert into credentials values (?, ?, ?, ?)")
      .run("c4", "AliExpress", "x:y:z", T);
    legacy.close();

    const report = await run(false);
    expect(report).toMatchObject({
      parcels: 6,
      mailboxes: 1,
      carriers: { dhl: 1, hermes: 1, dpd: 1, cainiao: 2, unknown: 1 },
      // p1 (dhl), p3 (dpd), p4 and p5 (cainiao); hermes is delivered and "unknown" has no plug-in.
      linkedParcels: 4,
      skippedCredentials: [{ service: "AliExpress" }, { service: "Amazon" }],
    });
    const tracking = (await context.services.sources.list()).filter((s) => s.kind === "tracking");
    expect(tracking.map((source) => source.plugin).sort()).toEqual(["cainiao", "dhl", "dpd"]);
    expect(tracking.every((source) => source.nextRunAt !== null)).toBe(true);
    const mailbox = (await context.services.sources.list()).find((s) => s.kind === "mail");
    expect(mailbox?.config).toMatchObject({ host: "imap.example.invalid", port: 993 });

    // Running it again links nothing new and changes no carrier.
    expect(await run(false)).toMatchObject({ linkedParcels: 0, correctedCarriers: 0 });
  });

  it("corrects a placeholder carrier left by an earlier import", async () => {
    const now = context.clock.now().toISOString();
    await context.services.db
      .insertInto("parcels")
      .values({
        id: "00000000-0000-4000-8000-000000000009",
        carrier: "china",
        barcode: "00340434000000000001",
        direction: "incoming",
        status: "in_transit",
        raw_status: null,
        delivered: 0,
        pickup: 0,
        label: null,
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .execute();
    expect(await run(false)).toMatchObject({ correctedCarriers: 1, skippedDuplicateParcels: 1 });
    expect(
      await context.services.parcels.repository.get("00000000-0000-4000-8000-000000000009"),
    ).toMatchObject({ carrier: "dhl" });
  });

  it("skips parcels that already exist when run twice", async () => {
    await run(false);
    const second = await run(false);
    expect(second).toMatchObject({ parcels: 0, skippedDuplicateParcels: 3 });
  });

  it("imports no credentials without the old key, and counts a wrong key as undecryptable", async () => {
    expect(await run(true, null)).toMatchObject({
      mailboxes: 0,
      skippedCredentials: [
        { service: "Amazon" },
        { service: "IMAP", reason: expect.stringContaining("OPENPARCELS_LEGACY_KEY") as string },
      ],
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
