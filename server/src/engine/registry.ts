import type { z } from "zod";
import type {
  CarrierPlugin,
  FetchResult,
  LiveReading,
  LiveTarget,
  PluginContext,
  PluginSourceKind,
} from "../plugin/api.js";
import type { Clock } from "../clock.js";
import type { HttpPolicy, PluginHttp } from "../plugin/http.js";

export class InvalidSourceConfigError extends Error {
  override readonly name = "InvalidSourceConfigError";
}

/** Everything a source needs to call a plug-in, before config and secret are validated. */
export type BaseContext = Omit<PluginContext<unknown, unknown>, "config" | "secret">;

/** Public description of a plug-in for the API and the UI. */
export interface PluginInfo {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly sourceKinds: readonly PluginSourceKind[];
  readonly signIn: string;
  readonly configSchema: z.ZodType;
  readonly secretSchema: z.ZodType;
  readonly browserUserAgentReason: string | null;
}

/**
 * A plug-in with its generic parameters erased. Config and secret arrive as stored JSON and are
 * validated against the plug-in's own schemas before the typed functions are called, so the
 * registry can hold plug-ins of different types without casts.
 */
export interface RegisteredPlugin {
  readonly info: PluginInfo;
  readonly http: HttpPolicy;
  readonly canFetchAccount: boolean;
  readonly canTrack: boolean;
  readonly canReadLive: boolean;
  validateConfig(raw: unknown): void;
  /** Pasted-redirect sign-in, step 1: the address the user opens in their own browser. */
  startSignIn(rawConfig: unknown, clock: Clock): Promise<{ url: string; state: unknown }>;
  /** Step 2: turns the pasted final address into the sign-in data to store. */
  finishSignIn(http: PluginHttp, clock: Clock, state: unknown, pasted: string): Promise<unknown>;
  readLive(
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
    target: LiveTarget,
  ): Promise<LiveReading | null>;
  fetchAccount(base: BaseContext, rawConfig: unknown, rawSecret: unknown): Promise<FetchResult>;
  track(
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
    barcodes: readonly string[],
  ): Promise<FetchResult>;
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string, pluginId: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new InvalidSourceConfigError(`The ${what} for ${pluginId} is invalid at: ${paths}.`);
  }
  return parsed.data;
}

export function register<Config, Secret>(plugin: CarrierPlugin<Config, Secret>): RegisteredPlugin {
  const context = (
    base: BaseContext,
    rawConfig: unknown,
    rawSecret: unknown,
  ): PluginContext<Config, Secret> => ({
    ...base,
    config: parseWith(plugin.configSchema, rawConfig, "configuration", plugin.id),
    secret: parseWith(plugin.secretSchema, rawSecret, "sign-in data", plugin.id),
  });
  return {
    info: {
      id: plugin.id,
      name: plugin.name,
      countries: plugin.countries,
      sourceKinds: plugin.sourceKinds,
      signIn: plugin.signIn.type,
      configSchema: plugin.configSchema,
      secretSchema: plugin.secretSchema,
      browserUserAgentReason: plugin.http.userAgent?.reason ?? null,
    },
    http: plugin.http,
    canFetchAccount: plugin.fetchAccount !== undefined,
    canTrack: plugin.track !== undefined,
    canReadLive: plugin.readLive !== undefined,
    async startSignIn(rawConfig, clock) {
      if (plugin.signIn.type !== "pasted_redirect") {
        throw new InvalidSourceConfigError(`${plugin.name} does not sign in with a pasted link.`);
      }
      return plugin.signIn.start({
        config: parseWith(plugin.configSchema, rawConfig, "configuration", plugin.id),
        clock,
      });
    },
    async finishSignIn(http, clock, state, pasted) {
      if (plugin.signIn.type !== "pasted_redirect") {
        throw new InvalidSourceConfigError(`${plugin.name} does not sign in with a pasted link.`);
      }
      const secret = await plugin.signIn.finish({ http, clock }, state, pasted);
      return parseWith(plugin.secretSchema, secret, "sign-in data", plugin.id);
    },
    async readLive(base, rawConfig, rawSecret, target) {
      if (plugin.readLive === undefined) {
        return null;
      }
      return plugin.readLive(context(base, rawConfig, rawSecret), target);
    },
    validateConfig(raw) {
      parseWith(plugin.configSchema, raw, "configuration", plugin.id);
    },
    async fetchAccount(base, rawConfig, rawSecret) {
      if (plugin.fetchAccount === undefined) {
        throw new InvalidSourceConfigError(`${plugin.name} has no account source.`);
      }
      return plugin.fetchAccount(context(base, rawConfig, rawSecret));
    },
    async track(base, rawConfig, rawSecret, barcodes) {
      if (plugin.track === undefined) {
        throw new InvalidSourceConfigError(`${plugin.name} cannot track codes.`);
      }
      return plugin.track(context(base, rawConfig, rawSecret), barcodes);
    },
  };
}

export class PluginRegistry {
  readonly #plugins = new Map<string, RegisteredPlugin>();

  constructor(plugins: readonly RegisteredPlugin[]) {
    for (const plugin of plugins) {
      if (this.#plugins.has(plugin.info.id)) {
        throw new Error(`Two carrier plug-ins share the id ${plugin.info.id}.`);
      }
      this.#plugins.set(plugin.info.id, plugin);
    }
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.#plugins.get(id);
  }

  list(): RegisteredPlugin[] {
    return [...this.#plugins.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }
}
