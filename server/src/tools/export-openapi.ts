/**
 * Writes the OpenAPI document to a file, without starting a server or touching real data: the
 * app is built against a throwaway database in a temporary directory. The web UI generates its
 * typed API client from this file.
 *
 * Usage: node dist/tools/export-openapi.js <output.json>
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pino } from "pino";
import { buildApp } from "../api/app.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { SecretBox } from "../crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import { createServices } from "../services.js";

async function main(): Promise<void> {
  const output = process.argv[2];
  if (output === undefined) {
    throw new Error("Pass the output file path.");
  }
  const dataDir = mkdtempSync(path.join(tmpdir(), "open-parcels-openapi-"));
  try {
    const config = loadConfig({ OPENPARCELS_DATA_DIR: dataDir, OPENPARCELS_TIMEZONE: "UTC" });
    const { db } = openDatabase(config.databasePath);
    await migrateToLatest(db);
    const services = await createServices({
      config,
      db,
      logger: pino({ level: "silent" }),
      clock: systemClock,
      secrets: new SecretBox(randomBytes(32)),
    });
    const app = await buildApp(services);
    writeFileSync(output, `${JSON.stringify(app.swagger(), null, 2)}\n`);
    await app.close();
    await db.destroy();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Exporting the OpenAPI document failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
