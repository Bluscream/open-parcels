import type { z } from "zod";
import type { Clock } from "../clock.js";
import type { HttpPolicy, PluginHttp } from "./http.js";
import type { ParcelSnapshot } from "./snapshot.js";

export * from "./errors.js";
export * from "./snapshot.js";
export type { HostLimit, HttpPolicy, HttpResponse, RequestOptions } from "./http.js";

/** Source kinds a carrier can offer. Mailboxes are handled by the core, not by carrier plug-ins. */
export const SOURCE_KINDS = ["account", "tracking", "shop"] as const;
export type PluginSourceKind = (typeof SOURCE_KINDS)[number];

/** Minimal structured logger handed to plug-ins. Messages are redacted before they are written. */
export interface PluginLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

/** Encrypted per-source storage for whatever the carrier renews: cookies, refresh tokens, device ids. */
export interface SessionStore {
  load(): unknown;
  save(value: unknown): Promise<void>;
}

export interface PluginContext<Config, Secret> {
  readonly sourceId: string;
  readonly config: Config;
  readonly secret: Secret;
  readonly http: PluginHttp;
  readonly clock: Clock;
  readonly logger: PluginLogger;
  readonly session: SessionStore;
  /**
   * Reports a status code, text or response key the plug-in could not map. The core warns once
   * per new value and records it for the "please report this" list. Pass keys or codes, never
   * values that may carry personal data.
   */
  reportUnknown(kind: string, key: string): void;
}

export interface FetchResult {
  readonly snapshots: readonly ParcelSnapshot[];
  /**
   * True when the list is everything the source currently has. Only complete results let the
   * reconciler conclude that a missing parcel is gone.
   */
  readonly complete: boolean;
}

/** How the user signs in. Each flow is driven by the generic sign-in routes and the UI. */
export type SignInFlow<Secret> =
  | { readonly type: "none" }
  | { readonly type: "credentials" }
  | { readonly type: "api_key" }
  | {
      /** The user signs in in their own browser and pastes the final redirect URL back. */
      readonly type: "pasted_redirect";
      start(context: {
        readonly config: unknown;
        readonly clock: Clock;
      }): Promise<{ url: string; state: unknown }>;
      finish(
        context: { readonly http: PluginHttp; readonly clock: Clock },
        state: unknown,
        pasted: string,
      ): Promise<Secret>;
    };

export interface CarrierPlugin<Config = unknown, Secret = unknown> {
  readonly id: string;
  readonly name: string;
  /** ISO 3166-1 alpha-2 codes, or `*` for worldwide. */
  readonly countries: readonly string[];
  readonly sourceKinds: readonly PluginSourceKind[];
  readonly configSchema: z.ZodType<Config>;
  readonly secretSchema: z.ZodType<Secret>;
  readonly signIn: SignInFlow<Secret>;
  readonly http: HttpPolicy;
  /** Account and shop sources: return everything the account lists. */
  fetchAccount?(context: PluginContext<Config, Secret>): Promise<FetchResult>;
  /** Tracking sources: look up these codes. A missing code in the result means "not found". */
  track?(context: PluginContext<Config, Secret>, barcodes: readonly string[]): Promise<FetchResult>;
}

/** Identity helper that keeps the generic parameters inferred from the schemas. */
export function defineCarrier<Config, Secret>(
  plugin: CarrierPlugin<Config, Secret>,
): CarrierPlugin<Config, Secret> {
  return plugin;
}
