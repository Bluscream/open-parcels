import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretAad, sessionAad } from "../../src/engine/sources.js";
import { importHaEntries, markerKey } from "../../src/migrate/ha/import.js";
import { createTestContext, type TestContext } from "../helpers.js";

/** Made-up sign-in values, built from parts so no literal token sits in the source. */
const fake = (name: string): string => ["fake", name, "0000"].join("-");
const AMAZON_TOKEN = fake("amazon-refresh");
const DHL_TOKEN = fake("dhl-refresh");
const HERMES_ACCESS = fake("hermes-access");
const HERMES_REFRESH = fake("hermes-refresh");
const SERIAL = "0123456789ABCDEF0123456789ABCDEF";
const GLS_INSTANCE = fake("gls-instance");

type Entry = Record<string, unknown>;

function entry(id: string, domain: string, title: string, data: Entry, options: Entry = {}) {
  return { entry_id: id, domain, title, data, options, disabled_by: null, source: "user" };
}

function fixture(): Entry[] {
  return [
    entry(
      "e-amazon",
      "amazon_orders",
      "Amazon (amazon.de)",
      { country: "amazon.de", device_serial: SERIAL, refresh_token: AMAZON_TOKEN },
      {
        delivered_filter_amount: 7,
        delivered_filter_type: "days",
        hand_off: true,
        include_history: false,
        live_tracking: true,
      },
    ),
    entry(
      "e-dhl-de",
      "dhl",
      "Germany (Test)",
      { account_subject: "sub-1", country: "DE", refresh_token: DHL_TOKEN },
      { tracked_codes: ["00340000000000000001"] },
    ),
    entry(
      "e-dhl-tracking",
      "dhl",
      "DHL tracking",
      { source: "tracking" },
      {
        parcels: [
          { tracking_code: "JVGL0000000000000001", direction: "incoming" },
          { tracking_code: "JVGL0000000000000002", direction: "outgoing" },
        ],
      },
    ),
    entry(
      "e-gls",
      "gls",
      "GLS DE (10115)",
      { de_app_instance_id: GLS_INSTANCE },
      {
        country: "DE",
        postal_code: "10115",
        parcels: [{ parcel_no: "00000000001", postal_code: "10115", de_parcel_number: "N-1" }],
      },
    ),
    entry("e-hermes", "hermes", "Hermes (user@example.invalid)", {
      source: "account",
      username: "user@example.invalid",
      access_token: HERMES_ACCESS,
      refresh_token: HERMES_REFRESH,
    }),
    entry("e-agg", "parcel_aggregator", "Open Parcels", {}),
    { ...entry("e-off", "gls", "GLS off", { country: "NL" }), disabled_by: "user" },
    entry("e-mqtt", "mqtt", "Broker", { broker: "core-mosquitto" }),
  ];
}

const file = (entries: Entry[]) => ({ version: 1, minor_version: 5, data: { entries } });

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});

afterEach(async () => {
  await context.close();
});

function run(entries: Entry[], dryRun = false) {
  return importHaEntries({
    configEntries: file(entries),
    db: context.services.db,
    secrets: context.services.secrets,
    clock: context.clock,
    dryRun,
  });
}

async function sources() {
  return context.services.db.selectFrom("sources").selectAll().orderBy("label").execute();
}

async function sourceByLabel(label: string) {
  const row = (await sources()).find((source) => source.label === label);
  if (row === undefined) {
    throw new Error(`No source ${label}`);
  }
  return row;
}

function decrypt(blob: Buffer | null, aad: string): unknown {
  return blob === null ? null : context.services.secrets.decryptJson(blob, aad);
}

async function linkedCodes(sourceId: string): Promise<string[]> {
  const rows = await context.services.db
    .selectFrom("parcel_sources")
    .innerJoin("parcels", "parcels.id", "parcel_sources.parcel_id")
    .select("parcels.barcode")
    .where("parcel_sources.source_id", "=", sourceId)
    .execute();
  return rows.map((row) => row.barcode).sort();
}

describe("Home Assistant suite import", () => {
  it("creates signed-in sources with the HA titles, sessions and codes", async () => {
    const report = await run(fixture());
    expect(report.sources.map((s) => [s.label, s.plugin, s.kind, s.action, s.state])).toEqual([
      ["DHL tracking", "dhl", "tracking", "created", "ok"],
      ["GLS DE (10115)", "gls", "tracking", "created", "ok"],
      ["Amazon (amazon.de)", "amazon", "shop", "created", "ok"],
      ["Germany (Test)", "dhl", "account", "created", "ok"],
      ["Hermes (user@example.invalid)", "hermes", "account", "created", "ok"],
    ]);

    const amazon = await sourceByLabel("Amazon (amazon.de)");
    expect(JSON.parse(amazon.config)).toEqual({ storefront: "amazon.de" });
    expect(decrypt(amazon.secret_blob, secretAad(amazon.id))).toEqual({
      refreshToken: AMAZON_TOKEN,
      deviceSerial: SERIAL,
    });
    expect(report.sources.find((s) => s.plugin === "amazon")?.notCarriedOver).toEqual([
      "delivered_filter_amount",
      "delivered_filter_type",
      "hand_off",
      "include_history",
      "live_tracking",
    ]);

    const dhl = await sourceByLabel("Germany (Test)");
    expect(JSON.parse(dhl.config)).toEqual({ account: "de" });
    expect(decrypt(dhl.secret_blob, secretAad(dhl.id))).toEqual({ refreshToken: DHL_TOKEN });

    // The DHL account's tracked codes join the imported DHL tracking source's own codes.
    const tracking = await sourceByLabel("DHL tracking");
    expect(await linkedCodes(tracking.id)).toEqual([
      "00340000000000000001",
      "JVGL0000000000000001",
      "JVGL0000000000000002",
    ]);
    const outgoing = await context.services.db
      .selectFrom("parcels")
      .select("direction")
      .where("barcode", "=", "JVGL0000000000000002")
      .executeTakeFirstOrThrow();
    expect(outgoing.direction).toBe("outgoing");

    const gls = await sourceByLabel("GLS DE (10115)");
    expect(JSON.parse(gls.config)).toEqual({ country: "DE", postalCode: "10115" });
    expect(gls.secret_blob).toBeNull();
    expect(decrypt(gls.session_blob, sessionAad(gls.id))).toEqual({
      de: {
        instanceId: GLS_INSTANCE,
        token: null,
        expiresAt: null,
        parcels: { "00000000001": "N-1" },
      },
    });
    expect(await linkedCodes(gls.id)).toEqual(["00000000001"]);

    const hermes = await sourceByLabel("Hermes (user@example.invalid)");
    expect(decrypt(hermes.secret_blob, secretAad(hermes.id))).toEqual({
      username: "user@example.invalid",
    });
    expect(decrypt(hermes.session_blob, sessionAad(hermes.id))).toEqual({
      accessToken: HERMES_ACCESS,
      refreshToken: HERMES_REFRESH,
    });

    expect(report.parcels).toEqual({ created: 4, existing: 0 });
    expect(report.covered.map((c) => c.domain)).toEqual(["parcel_aggregator"]);
    expect(report.skipped).toEqual([
      expect.objectContaining({ entryId: "e-off", reason: "Disabled in Home Assistant." }),
    ]);
    expect(report.unrecognised).toEqual({ mqtt: 1 });
  });

  it("never prints a token, an instance id or a serial", async () => {
    const report = JSON.stringify(await run(fixture()));
    for (const value of [
      AMAZON_TOKEN,
      DHL_TOKEN,
      HERMES_ACCESS,
      HERMES_REFRESH,
      GLS_INSTANCE,
      SERIAL,
    ]) {
      expect(report).not.toContain(value);
    }
  });

  it("writes nothing on a dry run but reports the same plan", async () => {
    const dry = await run(fixture(), true);
    expect(dry.dryRun).toBe(true);
    expect(dry.sources).toHaveLength(5);
    expect(await sources()).toEqual([]);
    expect(
      await context.services.db
        .selectFrom("settings")
        .select("key")
        .where("key", "like", "ha_import:%")
        .execute(),
    ).toEqual([]);
    expect(await context.services.db.selectFrom("parcels").select("id").execute()).toEqual([]);
  });

  it("updates on a re-run without duplicating and keeps tokens the source rotated", async () => {
    await run(fixture());
    const before = await sources();
    const hermes = await sourceByLabel("Hermes (user@example.invalid)");
    const rotated = { accessToken: fake("rotated-a"), refreshToken: fake("rotated-r") };
    await context.services.db
      .updateTable("sources")
      .set({ session_blob: context.services.secrets.encryptJson(rotated, sessionAad(hermes.id)) })
      .where("id", "=", hermes.id)
      .execute();

    const entries = fixture();
    const amazon = entries[0] as { title: string };
    amazon.title = "Amazon renamed";
    const again = await run(entries);
    expect(again.sources.every((s) => s.action === "updated")).toBe(true);
    expect(again.parcels).toEqual({ created: 0, existing: 4 });
    const after = await sources();
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    expect(after.map((s) => s.label)).toContain("Amazon renamed");
    expect(await context.services.db.selectFrom("parcels").select("id").execute()).toHaveLength(4);
    expect(
      decrypt((await sourceByLabel(hermes.label)).session_blob, sessionAad(hermes.id)),
    ).toEqual(rotated);

    // A new sign-in in HA since the last import replaces the stored one.
    const changed = fixture();
    (changed[4] as { data: Entry }).data["access_token"] = fake("new-access");
    const third = await run(changed);
    expect(third.sources.find((s) => s.plugin === "hermes")?.credentialsWritten).toBe(true);
    expect(
      decrypt((await sourceByLabel(hermes.label)).session_blob, sessionAad(hermes.id)),
    ).toEqual({
      accessToken: fake("new-access"),
      refreshToken: HERMES_REFRESH,
    });
    const marker = await context.services.db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", markerKey("e-hermes"))
      .executeTakeFirstOrThrow();
    expect(marker.value).not.toContain(HERMES_REFRESH);
  });

  it("keys the credential fingerprint and still honours an unkeyed one from before", async () => {
    await run(fixture());
    const hermes = await sourceByLabel("Hermes (user@example.invalid)");
    const read = async () =>
      JSON.parse(
        (
          await context.services.db
            .selectFrom("settings")
            .select("value")
            .where("key", "=", markerKey("e-hermes"))
            .executeTakeFirstOrThrow()
        ).value,
      ) as { credentials: string; sourceId: string };
    const stored = await read();
    const session = decrypt(hermes.session_blob, sessionAad(hermes.id));
    const secret =
      hermes.secret_blob === null ? null : decrypt(hermes.secret_blob, secretAad(hermes.id));
    const plain = createHash("sha256")
      .update(JSON.stringify({ secret, session }))
      .digest("hex")
      .slice(0, 16);
    expect(stored.credentials).toMatch(/^[0-9a-f]{16}$/);
    expect(stored.credentials).not.toBe(plain);

    // A marker written by an earlier version (unkeyed) is not mistaken for a new HA sign-in.
    await context.services.db
      .updateTable("settings")
      .set({ value: JSON.stringify({ ...stored, credentials: plain }) })
      .where("key", "=", markerKey("e-hermes"))
      .execute();
    const again = await run(fixture());
    expect(again.sources.find((s) => s.plugin === "hermes")?.credentialsWritten).toBe(false);
  });

  it("creates sources it cannot sign in as needing a sign-in, with the reason", async () => {
    const report = await run([
      entry("h", "hermes", "Hermes (nobody)", { source: "account", username: "nobody" }),
      entry("d", "dhl", "Germany (none)", { country: "DE" }),
      entry("a", "amazon_orders", "Amazon (amazon.de)", { country: "amazon.de" }),
      entry("p", "dhl", "Poland", { country: "PL", pl_device_id: "x", pl_cookies: {} }),
      entry("n", "amazon_orders", "Amazon (amazon.nl)", { country: "amazon.nl" }),
      entry("k", "dhl", "API (abcdef)", { source: "api", api_key: fake("key") }),
    ]);
    expect(report.sources.map((s) => [s.label, s.state, s.signedIn])).toEqual([
      ["Hermes (nobody)", "needs_sign_in", false],
      ["Germany (none)", "needs_sign_in", false],
      ["Amazon (amazon.de)", "needs_sign_in", false],
      ["Poland", "needs_sign_in", false],
    ]);
    expect(report.sources[0]?.stateDetail).toMatch(/Credentials missing/);
    const rows = await sources();
    expect(rows.every((s) => s.state === "needs_sign_in" && s.next_run_at === null)).toBe(true);
    expect(report.skipped.map((s) => s.entryId)).toEqual(["n", "k"]);
  });

  it("rejects a file that is not core.config_entries", async () => {
    await expect(
      importHaEntries({
        configEntries: { data: {} },
        db: context.services.db,
        secrets: context.services.secrets,
        clock: context.clock,
        dryRun: false,
      }),
    ).rejects.toThrow(/core\.config_entries/);
  });
});

describe("an existing tracking source", () => {
  it("is adopted instead of a second keyless DHL tracking source, keeping its id and label", async () => {
    const now = context.clock.now().toISOString();
    const existing = crypto.randomUUID();
    await context.services.db
      .insertInto("sources")
      .values({
        id: existing,
        plugin: "dhl",
        kind: "tracking",
        label: "DHL tracking (auto)",
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_detail: null,
        next_run_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await run(fixture());
    await run(fixture());
    const tracking = (await sources()).filter(
      (source) => source.plugin === "dhl" && source.kind === "tracking",
    );
    expect(tracking.map((source) => [source.id, source.label])).toEqual([
      [existing, "DHL tracking (auto)"],
    ]);
    expect(await linkedCodes(existing)).toContain("JVGL0000000000000001");
  });
});
