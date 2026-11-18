import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  announceToHomeAssistant,
  APP_INGRESS_PORT,
  isSupervised,
  supervisedEnvironment,
} from "../../src/ha/supervisor.js";
import { createTestContext, type TestContext } from "../helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "open-parcels-ha-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Home Assistant app support", () => {
  it("detects the Supervisor by its token", () => {
    expect(isSupervised({})).toBe(false);
    expect(isSupervised({ SUPERVISOR_TOKEN: "x" })).toBe(true);
  });

  it("maps app options to environment variables, letting explicit variables win", () => {
    const file = path.join(dir, "options.json");
    writeFileSync(
      file,
      JSON.stringify({ log_level: "debug", timezone: "Europe/Berlin", archive_days: 14 }),
    );
    const env = supervisedEnvironment({ OPENPARCELS_LOG_LEVEL: "warn" }, file);
    expect(env).toMatchObject({
      OPENPARCELS_LOG_LEVEL: "warn",
      OPENPARCELS_TIMEZONE: "Europe/Berlin",
      OPENPARCELS_ARCHIVE_DAYS: "14",
      OPENPARCELS_INGRESS_PORT: String(APP_INGRESS_PORT),
      OPENPARCELS_DATA_DIR: "/data",
    });
  });

  it("announces itself with a fresh token and revokes the previous one", async () => {
    const context: TestContext = await createTestContext();
    try {
      const sent: { url: string; body: unknown }[] = [];
      const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
        sent.push({ url, body: JSON.parse(typeof init.body === "string" ? init.body : "null") });
        return Promise.resolve(new Response("{}", { status: 200 }));
      };
      const options = {
        token: "supervisor",
        auth: context.services.auth,
        port: 3000,
        logger: pino({ level: "silent" }),
        fetchImpl,
      };
      await announceToHomeAssistant(options);
      await announceToHomeAssistant(options);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({
        url: "http://supervisor/discovery",
        body: { service: "open_parcels", config: { port: 3000 } },
      });
      const tokens = await context.services.auth.listTokens();
      expect(tokens.filter((token) => token.name.startsWith("Home Assistant"))).toHaveLength(1);
      const latest = (sent[1]?.body as { config: { api_token: string } }).config.api_token;
      expect(await context.services.auth.findToken(latest)).toBeDefined();
    } finally {
      await context.close();
    }
  });
});
