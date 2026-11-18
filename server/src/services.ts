import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { humanCode } from "./auth/crypto.js";
import { AuthStore } from "./auth/store.js";
import type { Clock } from "./clock.js";
import type { AppConfig } from "./config.js";
import type { SecretBox } from "./crypto/secrets.js";
import type { Database } from "./db/schema.js";
import { EventBus } from "./events/bus.js";
import { ParcelService } from "./parcels/service.js";

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
  readonly auth: AuthStore;
  readonly bus: EventBus;
  readonly parcels: ParcelService;
  readonly setup: SetupGate;
}

export interface ServiceDeps {
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secrets: SecretBox;
}

export async function createServices(deps: ServiceDeps): Promise<Services> {
  const auth = new AuthStore(deps.db, deps.clock);
  const bus = new EventBus(deps.db, deps.clock, deps.logger);
  await bus.start();
  const setup = new SetupGate((await auth.hasOwner()) ? undefined : humanCode());
  return {
    ...deps,
    auth,
    bus,
    parcels: new ParcelService(deps.db, bus, deps.clock),
    setup,
  };
}
