import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "./api/app.js";
import { HA_INGRESS_ADDRESS } from "./api/auth-plugin.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { loadSecretKey, SecretBox } from "./crypto/secrets.js";
import { migrateToLatest, openDatabase } from "./db/database.js";
import { cleanupMailFalsePositives } from "./engine/mail-cleanup.js";
import { applyRetention } from "./engine/retention.js";
import { loadRules } from "open-parcels-rules";
import { announceToHomeAssistant, isSupervised, supervisedEnvironment } from "./ha/supervisor.js";
import { createLogger } from "./log/logger.js";
import { createServices, type Services } from "./services.js";

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

async function runMaintenance(services: Services): Promise<void> {
  const sessions = await services.auth.pruneExpiredSessions();
  const events = await services.bus.pruneExpired();
  const images = await services.images.prune();
  const tiles = await services.tiles.prune();
  const retention = await applyRetention(services.db, services.clock, services.config.retention);
  services.logger.debug({ sessions, events, images, tiles, ...retention }, "Maintenance finished.");
}

async function main(): Promise<void> {
  const supervised = isSupervised();
  const config = loadConfig(supervised ? supervisedEnvironment(process.env) : process.env);
  const logger = createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });

  const { db } = openDatabase(config.databasePath);
  const applied = await migrateToLatest(db);
  if (applied.length > 0) {
    logger.info({ migrations: applied }, "Database migrated.");
  }

  const { key, created } = loadSecretKey(config.secretKey, config.dataDir);
  if (created) {
    logger.warn(
      "Created a new encryption key in the data directory. Back it up together with the database.",
    );
  }

  const services = await createServices({
    config,
    db,
    logger,
    clock: systemClock,
    secrets: new SecretBox(key),
  });
  if (services.setup.code !== undefined) {
    logger.warn(
      `First start: open the web UI and enter the setup code ${services.setup.code} to set the owner password.`,
    );
  }

  // server/dist/main.js → web/dist at the repository (or image) root.
  const webDir = config.webDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const servers: App[] = [await buildApp(services, { webDir })];
  await servers[0]?.listen({ host: config.host, port: config.port });
  if (config.ingressPort !== undefined) {
    const ingress = await buildApp(services, {
      trustedIngressAddress: HA_INGRESS_ADDRESS,
      webDir,
    });
    await ingress.listen({ host: config.host, port: config.ingressPort });
    servers.push(ingress);
  }

  const cleanup = await cleanupMailFalsePositives(db, systemClock, loadRules());
  if (cleanup.ran) {
    logger.info(
      { archived: cleanup.archived, boilerplateItemsRemoved: cleanup.boilerplateItemsRemoved },
      "Mail false-positive cleanup finished.",
    );
  }

  await services.reconciler.repair();
  services.scheduler.start();
  services.live.start();
  await services.mail.start();

  const supervisorToken = process.env["SUPERVISOR_TOKEN"];
  if (supervised && supervisorToken !== undefined) {
    announceToHomeAssistant({
      token: supervisorToken,
      auth: services.auth,
      port: config.port,
      logger,
    }).catch((error: unknown) => {
      logger.warn(
        { err: error },
        "Announcing to Home Assistant failed; add the integration by hand.",
      );
    });
  }

  const maintenance = setInterval(() => {
    runMaintenance(services).catch((error: unknown) => {
      logger.error({ err: error }, "Maintenance failed.");
    });
  }, MAINTENANCE_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Shutting down.");
    clearInterval(maintenance);
    services.scheduler.stop();
    services.live.stop();
    services.mail
      .stop()
      .then(() => Promise.all(servers.map((server) => server.close())))
      .then(() => db.destroy())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet (bad configuration), so this is the one place that writes to stderr directly.
  process.stderr.write(
    `open-parcels failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
