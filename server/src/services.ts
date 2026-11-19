import path from "node:path";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { humanCode } from "./auth/crypto.js";
import { AuthStore } from "./auth/store.js";
import { CalendarService } from "./calendar/service.js";
import { BUILTIN_CARRIERS } from "./engine/builtin-carriers.js";
import { isoNow, type Clock } from "./clock.js";
import type { AppConfig } from "./config.js";
import type { SecretBox } from "./crypto/secrets.js";
import type { Database } from "./db/schema.js";
import { LiveTracker } from "./engine/live.js";
import { repairBarcodes } from "./engine/barcode-repair.js";
import { scrubStoredRaw } from "./engine/raw-scrub.js";
import { trackingSourceIn } from "./engine/linking.js";
import { Reconciler } from "./engine/reconciler.js";
import { PluginRegistry, type RegisteredPlugin } from "./engine/registry.js";
import { SourceRunner } from "./engine/runner.js";
import { SignInService } from "./engine/sign-in.js";
import { Scheduler } from "./engine/scheduler.js";
import { repairOrderShops } from "./engine/order-repair.js";
import { mergeDuplicateTrackingSources } from "./engine/source-dedup.js";
import { SourceService } from "./engine/sources.js";
import { reviveTrackingRemovals } from "./engine/tracking-removal-repair.js";
import { rewriteOffsetTimes } from "./engine/utc-repair.js";
import { EventBus } from "./events/bus.js";
import { ImageProxy } from "./images/proxy.js";
import { loadRules } from "open-parcels-rules";
import { imapClientFactory } from "./mail/imap-client.js";
import { createMailInterpreter } from "./mail/interpret.js";
import type { MailboxClientFactory, MailInterpreter } from "./mail/types.js";
import { MailWatcher } from "./mail/watcher.js";
import type { Presentation } from "./parcels/repository.js";
import { ParcelService } from "./parcels/service.js";
import { OrderService } from "./orders/service.js";
import { HostLimiter, realSleep, type FetchLike, type Sleep } from "./plugin/http.js";
import { availableLayers } from "./tiles/layers.js";
import { TileProxy } from "./tiles/proxy.js";
import { Geocoder } from "./geo/geocoder.js";
import { ConfigSettings } from "./settings/config-settings.js";
import { SettingsStore } from "./settings/store.js";
import { CollageMaker } from "./images/collage.js";

/** How this server identifies itself to OpenStreetMap's services. */
const USER_AGENT =
  "open-parcels/2.0 (self-hosted parcel tracker; +https://github.com/open-parcels/open-parcels)";

/**
 * One-time code that has to accompany the first owner password. It is printed to the container
 * log only, so whoever first reaches the setup page over the network cannot claim the instance.
 */
export class SetupGate {
  #code: string | undefined;

  constructor(code: string | undefined) {
    this.#code = code;
  }

  get pending(): boolean {
    return this.#code !== undefined;
  }

  get code(): string | undefined {
    return this.#code;
  }

  matches(candidate: string): boolean {
    const normalise = (value: string): string => value.toUpperCase().replace(/[^A-Z]/g, "");
    return this.#code !== undefined && normalise(candidate) === normalise(this.#code);
  }

  complete(): void {
    this.#code = undefined;
  }
}

export interface Services {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secrets: SecretBox;
  readonly installId: string;
  readonly auth: AuthStore;
  readonly bus: EventBus;
  readonly registry: PluginRegistry;
  readonly sources: SourceService;
  readonly images: ImageProxy;
  readonly tiles: TileProxy;
  readonly geocoder: Geocoder;
  readonly settings: SettingsStore;
  readonly configSettings: ConfigSettings;
  readonly collages: CollageMaker;
  readonly mail: MailWatcher;
  readonly reconciler: Reconciler;
  readonly runner: SourceRunner;
  readonly scheduler: Scheduler;
  readonly live: LiveTracker;
  readonly calendar: CalendarService;
  readonly signIn: SignInService;
  readonly parcels: ParcelService;
  readonly orders: OrderService;
  readonly setup: SetupGate;
}

export interface ServiceDeps {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secrets: SecretBox;
  /** Overrides for tests: plug-ins, the network and waiting. */
  readonly plugins?: readonly RegisteredPlugin[];
  readonly fetchImpl?: FetchLike;
  readonly sleep?: Sleep;
  readonly mailClientFactory?: MailboxClientFactory;
  readonly mailInterpreter?: MailInterpreter;
}

/**
 * Links active parcels that no carrier source follows (found in mail, imported, or left over from
 * an older version) to their carrier's tracking source and makes those sources due. Returns true
 * when anything was linked.
 */
async function followUntracked(
  sources: SourceService,
  registry: PluginRegistry,
  logger: Logger,
  viaSource?: string,
): Promise<boolean> {
  const linked = await sources.linkUntracked(viaSource === undefined ? {} : { viaSource });
  for (const sourceId of linked.sources) {
    await sources.requestRun(sourceId);
  }
  const needSettings = [...linked.unlinkedCarriers].filter(
    (carrier) => registry.get(carrier)?.canTrack === true,
  );
  if (needSettings.length > 0) {
    logger.warn(
      { carriers: needSettings },
      "Parcels wait for a tracking source: these carriers need settings, add the source by hand.",
    );
  }
  return linked.parcels > 0;
}

/** A random id per installation, stored once; it spreads polling of different installs apart. */
async function loadInstallId(db: Kysely<Database>, clock: Clock): Promise<string> {
  const row = await db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", "install_id")
    .executeTakeFirst();
  if (row !== undefined) {
    return JSON.parse(row.value) as string;
  }
  const id = crypto.randomUUID();
  await db
    .insertInto("settings")
    .values({ key: "install_id", value: JSON.stringify(id), updated_at: isoNow(clock) })
    .execute();
  return id;
}

export async function createServices(deps: ServiceDeps): Promise<Services> {
  const { db, clock, logger } = deps;
  // First: values saved in the UI change `deps.config` in place before anything reads it.
  const configSettings = new ConfigSettings(db, clock, logger, deps.config, (key, config) => {
    if (key === "OPENPARCELS_LOG_LEVEL") logger.level = config.logLevel;
  });
  await configSettings.load();
  const installId = await loadInstallId(db, clock);
  const auth = new AuthStore(db, clock);
  const bus = new EventBus(db, clock, logger);
  await bus.start();
  const registry = new PluginRegistry(deps.plugins ?? BUILTIN_CARRIERS);
  const sources = new SourceService(db, registry, deps.secrets, bus, clock);
  // Repairs on every start. Duplicate keyless tracking sources are merged first, so parcels
  // imported or added before they could be linked are then followed by the surviving one.
  const mergedSources = await mergeDuplicateTrackingSources(db, clock);
  if (mergedSources > 0) {
    await bus.notify();
    logger.info({ merged: mergedSources }, "Merged duplicate tracking sources.");
  }
  const repairedOrders = await repairOrderShops(db, clock);
  if (repairedOrders > 0) {
    logger.info({ repaired: repairedOrders }, "Moved orders filed under the wrong shop.");
  }
  const rewrittenTimes = await rewriteOffsetTimes(db);
  if (rewrittenTimes > 0) {
    logger.info({ rewritten: rewrittenTimes }, "Rewrote stored times with an offset as UTC.");
  }
  const barcodes = await repairBarcodes(db, clock);
  if (barcodes.respelled > 0 || barcodes.folded > 0) {
    await bus.notify();
    logger.info(
      barcodes,
      "Stored codes in their carrier's spelling and merged case or space twins.",
    );
  }
  const scrubbed = await scrubStoredRaw(db);
  if (scrubbed > 0) {
    logger.info({ scrubbed }, "Removed codes and personal data from stored raw payloads.");
  }
  const revived = await reviveTrackingRemovals(db, clock);
  if (revived > 0) {
    logger.info({ revived }, "Revived parcels removed only because a lookup did not find them.");
  }
  if (await followUntracked(sources, registry, logger)) {
    logger.info("Linked parcels without a tracking source to their carrier.");
  }
  const images = new ImageProxy({
    secretKey: deps.secrets.derive("image proxy"),
    cacheDir: path.join(deps.config.dataDir, "images"),
    logger,
    allowedHosts: () => registry.list().flatMap((plugin) => plugin.info.imageHosts),
  });
  const tiles = new TileProxy({
    cacheDir: path.join(deps.config.dataDir, "tiles"),
    userAgent: USER_AGENT,
    // Read per request: a custom provider saved in the UI applies at once.
    layers: () => availableLayers(deps.config.map.custom),
  });
  const geocoder = new Geocoder({
    userAgent: USER_AGENT,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  const settings = new SettingsStore(db, clock);
  await settings.load();
  // Filled in once the live tracker exists; reads before that see no positions.
  const presentation: Presentation = {
    position: (parcelId) => live.position(parcelId),
    imagePath: (remote) => images.pathFor(remote),
    labelMode: () => settings.labelMode,
  };
  const reconciler = new Reconciler(db, bus, clock, logger, presentation);
  const runner = new SourceRunner({
    db,
    registry,
    secrets: deps.secrets,
    reconciler,
    limiter: new HostLimiter(clock, deps.sleep ?? realSleep),
    bus,
    clock,
    logger,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });
  // The scheduler hands live targets to the tracker after each poll, and the tracker asks the
  // scheduler for an immediate poll when a session ends; the closures break the cycle.
  const scheduler: Scheduler = new Scheduler({
    db,
    runner,
    sources,
    reconciler,
    clock,
    logger,
    timeZone: deps.config.timeZone,
    // Read on every run, so a change on the Settings page applies at once.
    get quietWindow() {
      return deps.config.quietWindow;
    },
    installId,
    pollIntervalOf: (plugin) => registry.get(plugin)?.info.pollIntervalMs ?? null,
    onRunSucceeded: (sourceId, liveTargets) => {
      live.setTargets(sourceId, liveTargets);
    },
  });
  const live: LiveTracker = new LiveTracker({
    db,
    runner,
    bus,
    clock,
    logger,
    refreshSource: async (sourceId) => {
      await sources.requestRun(sourceId);
      scheduler.wake();
    },
    presentation,
  });
  const parcels = new ParcelService(
    db,
    bus,
    clock,
    async (carrier) => {
      // Undefined when no plug-in tracks the carrier, or its plug-in needs settings first.
      const sourceId = await trackingSourceIn(db, registry, clock)(carrier);
      if (sourceId === undefined) {
        return undefined;
      }
      await sources.requestRun(sourceId);
      scheduler.wake();
      return sourceId;
    },
    presentation,
  );
  const mail = new MailWatcher({
    db,
    secrets: deps.secrets,
    sources,
    reconciler,
    clock,
    logger,
    clientFactory: deps.mailClientFactory ?? imapClientFactory,
    interpret: deps.mailInterpreter ?? createMailInterpreter(loadRules(), deps.config.timeZone),
    followUp: async (sourceId) => {
      if (await followUntracked(sources, registry, logger, sourceId)) {
        scheduler.wake();
      }
    },
  });
  const setup = new SetupGate((await auth.hasOwner()) ? undefined : humanCode());
  return {
    ...deps,
    installId,
    auth,
    bus,
    registry,
    sources,
    images,
    tiles,
    geocoder,
    settings,
    configSettings,
    collages: new CollageMaker(path.join(deps.config.dataDir, "collages")),
    mail,
    reconciler,
    runner,
    scheduler,
    live,
    calendar: new CalendarService(db, clock, deps.config.timeZone),
    signIn: new SignInService({
      db,
      registry,
      sources,
      secrets: deps.secrets,
      clock,
      logger,
      httpFor: (policy) => runner.httpFor(policy),
      exclusive: (sourceId, work) => runner.exclusive(sourceId, work),
    }),
    parcels,
    orders: new OrderService(db, bus, clock, presentation),
    setup,
  };
}
