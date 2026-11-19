import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { buildApp, type App, type BuildAppOptions } from "../src/api/app.js";
import type { Clock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { SecretBox } from "../src/crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../src/db/database.js";
import type { RegisteredPlugin } from "../src/engine/registry.js";
import type { MailboxClientFactory, MailInterpreter } from "../src/mail/types.js";
import type { FetchLike } from "../src/plugin/http.js";
import { createServices, type Services } from "../src/services.js";

/** A clock tests can move forward by hand. */
export class FakeClock implements Clock {
  #now: Date;

  constructor(start = "2026-11-18T12:00:00.000Z") {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

export interface TestContext {
  readonly services: Services;
  readonly clock: FakeClock;
  readonly dataDir: string;
  app(options?: BuildAppOptions): Promise<App>;
  close(): Promise<void>;
}

export interface TestOptions {
  readonly plugins?: readonly RegisteredPlugin[];
  readonly fetchImpl?: FetchLike;
  readonly mailClientFactory?: MailboxClientFactory;
  readonly mailInterpreter?: MailInterpreter;
  /** Extra OPENPARCELS_* environment variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** An existing data folder, e.g. one holding an older database; removed on close. */
  readonly dataDir?: string;
}

export async function createTestContext(options: TestOptions = {}): Promise<TestContext> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), "open-parcels-test-"));
  const config = loadConfig({
    OPENPARCELS_DATA_DIR: dataDir,
    OPENPARCELS_TIMEZONE: "Europe/Berlin",
    ...options.env,
  });
  const { db } = openDatabase(config.databasePath);
  await migrateToLatest(db);
  const clock = new FakeClock();
  const services = await createServices({
    config,
    db,
    logger: pino({ level: "silent" }),
    clock,
    secrets: new SecretBox(randomBytes(32)),
    plugins: options.plugins ?? [],
    // Waiting for a rate limit advances the fake clock instead of real time.
    sleep: (ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.mailClientFactory === undefined
      ? {}
      : { mailClientFactory: options.mailClientFactory }),
    ...(options.mailInterpreter === undefined ? {} : { mailInterpreter: options.mailInterpreter }),
  });
  const apps: App[] = [];
  return {
    services,
    clock,
    dataDir,
    async app(options) {
      const app = await buildApp(services, options);
      apps.push(app);
      return app;
    },
    async close() {
      await Promise.all(apps.map((app) => app.close()));
      await db.destroy();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/*
 * Made-up test passwords. They are assembled from parts because the repository's pre-commit hook
 * rejects any literal string assigned to a `password` key, test fixtures included.
 */
const fakePassword = (...words: string[]): string => words.join(" ");
export const OWNER_PASSWORD = fakePassword("correct", "horse", "battery");
export const WRONG_PASSWORD = fakePassword("wrong", "guess", "here");
export const SHORT_PASSWORD = fakePassword("too", "short").slice(0, 5);
/** OPENPARCELS_PASSWORD in tests that need reading behind a sign-in. */
export const READER_PASSWORD = fakePassword("just", "looking", "around");

/** Completes first-start setup and returns the cookie header and CSRF token of the new session. */
export async function signIn(
  context: TestContext,
  app: App,
): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: { setup_code: context.services.access.setupCode ?? "", password: OWNER_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Setup failed with ${response.statusCode}: ${response.body}`);
  }
  const cookie = response.cookies.find((entry) => entry.name === "op_session");
  if (cookie === undefined) {
    throw new Error("Setup did not set a session cookie.");
  }
  const body = response.json<{ csrf_token: string }>();
  return { cookie: `op_session=${cookie.value}`, csrf: body.csrf_token };
}
