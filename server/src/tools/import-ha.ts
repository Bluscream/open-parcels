/**
 * Imports the Home Assistant parcel suite's config entries as signed-in sources.
 *
 * Usage: node dist/tools/import-ha.js <path to .storage/core.config_entries | -> [--dry-run]
 *
 * `-` reads the file from stdin. Uses the same OPENPARCELS_* environment as the server (data
 * directory, encryption key). Prints labels, states and counts; never a token.
 */
import { readFileSync } from "node:fs";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { loadSecretKey, SecretBox } from "../crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import { importHaEntries } from "../migrate/ha/import.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args.find((arg) => arg === "-" || !arg.startsWith("--"));
  if (input === undefined) {
    throw new Error("Pass the path of core.config_entries, or - to read it from stdin.");
  }
  const configEntries = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf8")) as unknown;
  const config = loadConfig();
  const { db } = openDatabase(config.databasePath);
  try {
    await migrateToLatest(db);
    const { key } = loadSecretKey(config.secretKey, config.dataDir);
    const report = await importHaEntries({
      configEntries,
      db,
      secrets: new SecretBox(key),
      clock: systemClock,
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  // JSON.parse errors can quote the input, which holds tokens: name the failure only.
  const message =
    error instanceof SyntaxError
      ? "The input is not valid JSON."
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`Import failed: ${message}\n`);
  process.exit(1);
});
