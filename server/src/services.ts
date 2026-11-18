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
import { Reconciler } from "./engine/reconciler.js";
import { PluginRegistry, type RegisteredPlugin } from "./engine/registry.js";
import { SourceRunner } from "./engine/runner.js";
import { SignInService } from "./engine/sign-in.js";
import { Scheduler } from "./engine/scheduler.js";
import { SourceService } from "./engine/sources.js";
import { EventBus } from "./events/bus.js";
import { ImageProxy } from "./images/proxy.js";
import { loadRules } from "open-parcels-rules";
import { imapClientFactory } from "./mail/imap-client.js";
import { createMailInterpreter } from "./mail/interpret.js";
import type { MailboxClientFactory, MailInterpreter } from "./mail/types.js";
import { MailWatcher } from "./mail/watcher.js";
import type { Presentation } from "./parcels/repository.js";
import { ParcelService } from "./parcels/service.js";
import { HostLimiter, realSleep, type FetchLike, type Sleep } from "./plugin/http.js";

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
  readonly mail: MailWatcher;
  readonly reconciler: Reconciler;
  readonly runner: SourceRunner;
  readonly scheduler: Scheduler;
  readonly live: LiveTracker;
  readonly calendar: CalendarService;
  readonly signIn: SignInService;
  readonly parcels: ParcelService;
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
async function followUntracked(sources: SourceService, viaSource?: string): Promise<boolean> {
  const linked = await sources.linkUntracked(viaSource === undefined ? {} : { viaSource });
  for (const sourceId of linked.sources) {
    await sources.requestRun(sourceId);
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
  const installId = await loadInstallId(db, clock);
  const auth = new AuthStore(db, clock);
  const bus = new EventBus(db, clock, logger);
  await bus.start();
  const registry = new PluginRegistry(deps.plugins ?? BUILTIN_CARRIERS);
  const sources = new SourceService(db, registry, deps.secrets, bus, clock);
  // Repair on every start: parcels imported or added before they could be linked get followed.
  if (await followUntracked(sources)) {
    logger.info("Linked parcels without a tracking source to their carrier.");
  }
  const images = new ImageProxy({
    secretKey: deps.secrets.derive("image proxy"),
    cacheDir: path.join(deps.config.dataDir, "images"),
    logger,
  });
  // Filled in once the live tracker exists; reads before that see no positions.
  const presentation: Presentation = {
    position: (parcelId) => live.position(parcelId),
    imagePath: (remote) => images.pathFor(remote),
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
    quietWindow: deps.config.quietWindow,
    installId,
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
      if (registry.get(carrier)?.canTrack !== true) {
        return undefined;
      }
      const sourceId = await sources.ensureTrackingSource(carrier);
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
      if (await followUntracked(sources, sourceId)) {
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
    }),
    parcels,
    setup,
  };
}
