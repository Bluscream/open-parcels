/**
 * Imports the database of the pre-rewrite open-parcels into this installation.
 *
 * Usage: node dist/tools/import-legacy.js <path to old data.db> [--dry-run]
 *
 * Uses the same OPENPARCELS_* environment as the server (data directory, encryption key). The old
 * encryption key, needed only to carry IMAP mailboxes over, is read from OPENPARCELS_LEGACY_KEY,
 * never from the command line. Prints counts only; no parcel data is written to the output.
 */
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { loadSecretKey, SecretBox } from "../crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../db/database.js";
import { importLegacy } from "../migrate/legacy.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const legacyPath = args.find((arg) => !arg.startsWith("--"));
  if (legacyPath === undefined) {
    throw new Error("Pass the path of the old data.db.");
  }
  const config = loadConfig();
  const { db } = openDatabase(config.databasePath);
  try {
    await migrateToLatest(db);
    const { key } = loadSecretKey(config.secretKey, config.dataDir);
    const report = await importLegacy({
      legacyPath,
      db,
      secrets: new SecretBox(key),
      clock: systemClock,
      legacyKeyHex: process.env["OPENPARCELS_LEGACY_KEY"],
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Import failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
