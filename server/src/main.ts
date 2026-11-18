import { mkdirSync } from "node:fs";
import { buildApp, type App } from "./api/app.js";
import { HA_INGRESS_ADDRESS } from "./api/auth-plugin.js";
import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { loadSecretKey, SecretBox } from "./crypto/secrets.js";
import { migrateToLatest, openDatabase } from "./db/database.js";
import { applyRetention } from "./engine/retention.js";
import { createLogger } from "./log/logger.js";
import { createServices, type Services } from "./services.js";

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

async function runMaintenance(services: Services): Promise<void> {
  const sessions = await services.auth.pruneExpiredSessions();
  const events = await services.bus.pruneExpired();
  const images = await services.images.prune();
  const retention = await applyRetention(services.db, services.clock, services.config.retention);
  services.logger.debug({ sessions, events, images, ...retention }, "Maintenance finished.");
}

async function main(): Promise<void> {
  const config = loadConfig();
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

  const servers: App[] = [await buildApp(services)];
  await servers[0]?.listen({ host: config.host, port: config.port });
  if (config.ingressPort !== undefined) {
    const ingress = await buildApp(services, { trustedIngressAddress: HA_INGRESS_ADDRESS });
    await ingress.listen({ host: config.host, port: config.ingressPort });
    servers.push(ingress);
  }

  services.scheduler.start();
  services.live.start();
  await services.mail.start();

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
