import type { z } from "zod";
import type {
  CarrierPlugin,
  FetchResult,
  LiveReading,
  LiveTarget,
  PluginContext,
  PluginSourceKind,
  SignInFlow,
  SignInInput,
  SignInTurn,
} from "../plugin/api.js";
import type { Clock } from "../clock.js";
import { InvalidConfigError } from "../plugin/errors.js";
import type { HttpPolicy, PluginHttp } from "../plugin/http.js";
import { fileUnderTracked } from "./tracked.js";

export class InvalidSourceConfigError extends Error {
  override readonly name = "InvalidSourceConfigError";
}

/** Everything a source needs to call a plug-in, before config and secret are validated. */
export type BaseContext = Omit<PluginContext<unknown, unknown>, "config" | "secret">;

export interface SignInFlowInfo {
  readonly id: string;
  readonly label: string;
  readonly type: "none" | "credentials" | "api_key" | "interactive";
  /** Source kinds the flow applies to; all of the plug-in's kinds when not restricted. */
  readonly kinds: readonly PluginSourceKind[];
  /** True when the flow only applies to some configurations. */
  readonly conditional: boolean;
  /** What the user fills in for a credentials or API-key flow; null means the plug-in's schema. */
  readonly fields: z.ZodType | null;
}

/** One call into an interactive flow: `start` (no state), `continue` (with input) or `poll`. */
export interface SignInCall {
  readonly action: "start" | "continue" | "poll";
  readonly flowId: string;
  readonly kind: PluginSourceKind;
  readonly rawConfig: unknown;
  readonly http: PluginHttp;
  readonly clock: Clock;
  readonly state?: unknown;
  readonly input?: SignInInput;
}

/** Public description of a plug-in for the API and the UI. */
export interface PluginInfo {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly sourceKinds: readonly PluginSourceKind[];
  /** Type of the default flow (`none`, `credentials`, `api_key` or `interactive`). */
  readonly signIn: string;
  readonly signInFlows: readonly SignInFlowInfo[];
  readonly configSchema: z.ZodType;
  readonly secretSchema: z.ZodType;
  /** Hosts the image proxy may fetch this carrier's pictures from (see `CarrierPlugin`). */
  readonly imageHosts: readonly string[];
  /** Fixed time between runs, or null for the adaptive schedule (see `CarrierPlugin`). */
  readonly pollIntervalMs: number | null;
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
  /** The sign-in flows that apply to a source of this kind and configuration, default first. */
  signInFlows(kind: PluginSourceKind, rawConfig: unknown): SignInFlowInfo[];
  /** Runs one call of an interactive flow. A finished sign-in's secret is already validated. */
  signInTurn(call: SignInCall): Promise<SignInTurn<unknown>>;
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

/** A plug-in's settings error, as the engine's own, so the source shows it as invalid settings. */
async function asSourceConfigError<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw new InvalidSourceConfigError(error.message);
    }
    throw error;
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string, pluginId: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new InvalidSourceConfigError(`The ${what} for ${pluginId} is invalid at: ${paths}.`);
  }
  return parsed.data;
}

function flowInfo<Config, Secret>(
  plugin: CarrierPlugin<Config, Secret>,
  flow: SignInFlow<Config, Secret>,
): SignInFlowInfo {
  return {
    id: flow.id ?? flow.type,
    label: flow.label ?? flow.type,
    type: flow.type,
    kinds: flow.kinds ?? plugin.sourceKinds,
    conditional: flow.when !== undefined,
    fields: flow.type === "interactive" ? null : (flow.fields ?? null),
  };
}

function flowsOf<Config, Secret>(
  plugin: CarrierPlugin<Config, Secret>,
): readonly SignInFlow<Config, Secret>[] {
  const flows: readonly SignInFlow<Config, Secret>[] = Array.isArray(plugin.signIn)
    ? plugin.signIn
    : [plugin.signIn as SignInFlow<Config, Secret>];
  const ids = new Set<string>();
  for (const flow of flows) {
    const id = flow.id ?? flow.type;
    if (ids.has(id)) {
      throw new Error(`Two sign-in flows of ${plugin.id} share the id ${id}.`);
    }
    ids.add(id);
  }
  return flows;
}

function applies<Config, Secret>(
  flow: SignInFlow<Config, Secret>,
  kind: PluginSourceKind,
  config: Config,
): boolean {
  return (flow.kinds?.includes(kind) ?? true) && (flow.when?.(config) ?? true);
}

/** The interactive half of `register`: picks the flow and validates what it finishes with. */
async function runSignIn<Config, Secret>(
  plugin: CarrierPlugin<Config, Secret>,
  flows: readonly SignInFlow<Config, Secret>[],
  call: SignInCall,
): Promise<SignInTurn<unknown>> {
  const config = parseWith(plugin.configSchema, call.rawConfig, "configuration", plugin.id);
  const flow = flows.find((candidate) => (candidate.id ?? candidate.type) === call.flowId);
  if (flow?.type !== "interactive" || !applies(flow, call.kind, config)) {
    throw new InvalidSourceConfigError(
      `${plugin.name} has no interactive sign-in "${call.flowId}" for this source.`,
    );
  }
  const context = { config, kind: call.kind, http: call.http, clock: call.clock };
  let turn: SignInTurn<Secret>;
  if (call.action === "start") {
    turn = await flow.start(context);
  } else if (call.action === "continue") {
    turn = await flow.continue(context, call.state, call.input ?? {});
  } else {
    if (flow.poll === undefined) {
      throw new InvalidSourceConfigError(`${plugin.name}'s sign-in has nothing to wait for.`);
    }
    turn = await flow.poll(context, call.state);
  }
  if ("secret" in turn) {
    return { secret: parseWith(plugin.secretSchema, turn.secret, "sign-in data", plugin.id) };
  }
  return turn;
}

export function register<Config, Secret>(plugin: CarrierPlugin<Config, Secret>): RegisteredPlugin {
  const flows = flowsOf(plugin);
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
      signIn: flows[0]?.type ?? "none",
      signInFlows: flows.map((flow) => flowInfo(plugin, flow)),
      configSchema: plugin.configSchema,
      secretSchema: plugin.secretSchema,
      imageHosts: plugin.imageHosts ?? [],
      pollIntervalMs: plugin.pollIntervalMs ?? null,
    },
    http: plugin.http,
    canFetchAccount: plugin.fetchAccount !== undefined,
    canTrack: plugin.track !== undefined,
    canReadLive: plugin.readLive !== undefined,
    signInFlows(kind, rawConfig) {
      const config = parseWith(plugin.configSchema, rawConfig, "configuration", plugin.id);
      return flows
        .filter((flow) => applies(flow, kind, config))
        .map((flow) => flowInfo(plugin, flow));
    },
    signInTurn: (call) => runSignIn(plugin, flows, call),
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
      return asSourceConfigError(plugin.fetchAccount(context(base, rawConfig, rawSecret)));
    },
    async track(base, rawConfig, rawSecret, barcodes) {
      if (plugin.track === undefined) {
        throw new InvalidSourceConfigError(`${plugin.name} cannot track codes.`);
      }
      const result = await asSourceConfigError(
        plugin.track(context(base, rawConfig, rawSecret), barcodes),
      );
      return fileUnderTracked(plugin.id, barcodes, result, base.logger);
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
