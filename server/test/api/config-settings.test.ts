import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { loadConfig } from "../../src/config.js";
import { ConfigSettings, type SettingInfo } from "../../src/settings/config-settings.js";
import { createTestContext, signIn, type TestContext, type TestOptions } from "../helpers.js";

interface WireInfo extends Omit<SettingInfo, "pendingRestart"> {
  readonly pending_restart: boolean;
}

let context: TestContext;
afterEach(async () => {
  await context.close();
});

async function setUp(
  options: TestOptions = {},
): Promise<{ app: App; headers: Record<string, string> }> {
  context = await createTestContext(options);
  const app = await context.app();
  const session = await signIn(context, app);
  return { app, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } };
}

async function list(app: App, headers: Record<string, string>): Promise<WireInfo[]> {
  return (await app.inject({ url: "/api/v1/settings/config", headers })).json<WireInfo[]>();
}

const find = (infos: readonly WireInfo[], key: string): WireInfo | undefined =>
  infos.find((info) => info.key === key);

async function lastSettingsEvent(): Promise<unknown> {
  const row = await context.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", "settings.updated")
    .orderBy("seq", "desc")
    .executeTakeFirst();
  return row === undefined ? undefined : JSON.parse(row.payload);
}

describe("server settings", () => {
  it("layer default < environment < saved value, and reset goes back", async () => {
    const { app, headers } = await setUp({ env: { OPENPARCELS_DELETE_DAYS: "100" } });
    let infos = await list(app, headers);
    expect(find(infos, "OPENPARCELS_ARCHIVE_DAYS")).toMatchObject({
      source: "default",
      value: 30,
      default: 30,
      apply: "live",
    });
    expect(find(infos, "OPENPARCELS_DELETE_DAYS")).toMatchObject({ source: "env", value: 100 });

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: { OPENPARCELS_DELETE_DAYS: 200 },
    });
    expect(patched.statusCode).toBe(200);
    infos = patched.json<WireInfo[]>();
    expect(find(infos, "OPENPARCELS_DELETE_DAYS")).toMatchObject({
      source: "override",
      value: 200,
    });
    expect(context.services.config.retention.deleteAfterDays).toBe(200);
    expect(await lastSettingsEvent()).toEqual({ changed: "OPENPARCELS_DELETE_DAYS" });

    const reset = await app.inject({
      method: "DELETE",
      url: "/api/v1/settings/config/OPENPARCELS_DELETE_DAYS",
      headers,
    });
    expect(find(reset.json<WireInfo[]>(), "OPENPARCELS_DELETE_DAYS")).toMatchObject({
      source: "env",
      value: 100,
    });
    expect(context.services.config.retention.deleteAfterDays).toBe(100);
  });

  it("applies live settings to the running config, the log level included", async () => {
    const { app, headers } = await setUp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: {
        OPENPARCELS_QUIET_WINDOW: false,
        OPENPARCELS_PUBLIC_URL: "https://parcels.example.org/",
      },
    });
    expect(response.statusCode).toBe(200);
    const { config, logger, configSettings } = context.services;
    // Directly, not through a request: the request log would then print at debug level.
    expect(await configSettings.patch({ OPENPARCELS_LOG_LEVEL: "debug" })).toMatchObject({
      ok: true,
    });
    expect(config.quietWindow).toBe(false);
    expect(config.publicUrl?.href).toBe("https://parcels.example.org/");
    expect(logger.level).toBe("debug");
    // The test logger is silent; keep it that way for the rest of the run.
    logger.level = "silent";
  });

  it("saves nothing when one entry is invalid", async () => {
    const { app, headers } = await setUp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: { OPENPARCELS_ARCHIVE_DAYS: 10, OPENPARCELS_DELETE_DAYS: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_setting" });
    expect(find(await list(app, headers), "OPENPARCELS_ARCHIVE_DAYS")).toMatchObject({
      source: "default",
      value: 30,
    });
    expect(await context.services.db.selectFrom("setting_overrides").selectAll().execute()).toEqual(
      [],
    );
  });

  it("refuses settings only the environment may set, and unknown keys", async () => {
    const { app, headers } = await setUp();
    for (const payload of [{ OPENPARCELS_DATA_DIR: "/elsewhere" }, { OPENPARCELS_NOPE: "x" }]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/config",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(find(await list(app, headers), "OPENPARCELS_DATA_DIR")).toMatchObject({
      apply: "env",
      source: "env",
    });
  });

  it("flags a saved restart setting until the next start, which applies it", async () => {
    const { app, headers } = await setUp();
    const before = context.services.config.timeZone;
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/config",
      headers,
      payload: { OPENPARCELS_TIMEZONE: "Asia/Tokyo" },
    });
    expect(find(response.json<WireInfo[]>(), "OPENPARCELS_TIMEZONE")).toMatchObject({
      apply: "restart",
      source: "override",
      value: "Asia/Tokyo",
      pending_restart: true,
    });
    expect(context.services.config.timeZone).toBe(before);

    // A new start over the same database.
    const config = loadConfig({ OPENPARCELS_DATA_DIR: context.dataDir });
    const restarted = new ConfigSettings(
      context.services.db,
      context.clock,
      pino({ level: "silent" }),
      config,
    );
    await restarted.load();
    expect(config.timeZone).toBe("Asia/Tokyo");
    expect(restarted.list().find((info) => info.key === "OPENPARCELS_TIMEZONE")).toMatchObject({
      pendingRestart: false,
    });
  });

  it("never returns a secret", async () => {
    const { app, headers } = await setUp({
      env: { OPENPARCELS_SECRET_KEY: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=" },
    });
    const response = await app.inject({ url: "/api/v1/settings/config", headers });
    expect(response.body).not.toContain("c2VjcmV0");
    expect(find(response.json<WireInfo[]>(), "OPENPARCELS_SECRET_KEY")).toMatchObject({
      secret: true,
      set: true,
      value: null,
      default: null,
    });
  });

  it("needs the admin scope", async () => {
    const { app } = await setUp();
    const { token } = await context.services.auth.createToken("reader", ["read"], null);
    const response = await app.inject({
      url: "/api/v1/settings/config",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
