import type { z } from "zod";
import type { Clock } from "../clock.js";
import type { HttpPolicy, PluginHttp } from "./http.js";
import type { LiveReading, LiveTarget } from "./live.js";
import type { SignInFlow } from "./sign-in.js";
import type { ParcelSnapshot } from "./snapshot.js";

export * from "./errors.js";
export * from "./kit/html.js";
export * from "./kit/json.js";
export * from "./kit/time.js";
export * from "./kit/track.js";
export * from "./rules.js";
export * from "./snapshot.js";
export type { Clock } from "../clock.js";
export type { Direction } from "../domain/parcel.js";
export type { LiveReading, LiveTarget } from "./live.js";
export { CookieJar, restoreJar, serializeJar } from "./cookies.js";
export { sameSite } from "./http.js";
export type { HostLimit, HttpPolicy, HttpResponse, PluginHttp, RequestOptions } from "./http.js";

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
   * reconciler conclude that a missing parcel is gone. Ignored for tracking sources: a lookup
   * never lists everything, and a code the carrier does not know goes through the not-found
   * lookup state instead.
   */
  readonly complete: boolean;
}

export { pastedRedirect } from "./sign-in.js";
export type {
  InteractiveSignIn,
  SignInContext,
  SignInField,
  SignInFlow,
  SignInInput,
  SignInOption,
  SignInScope,
  SignInStep,
  SignInStepKind,
  SignInTurn,
  StaticSignIn,
} from "./sign-in.js";

export interface CarrierPlugin<Config = unknown, Secret = unknown> {
  readonly id: string;
  readonly name: string;
  /** ISO 3166-1 alpha-2 codes, or `*` for worldwide. */
  readonly countries: readonly string[];
  readonly sourceKinds: readonly PluginSourceKind[];
  /**
   * Hosts the image proxy may fetch this carrier's item pictures and delivery photos from; a
   * leading dot also allows subdomains (`.media-example.com`). Unset: the proxy fetches nothing.
   */
  readonly imageHosts?: readonly string[];
  readonly configSchema: z.ZodType<Config>;
  readonly secretSchema: z.ZodType<Secret>;
  /**
   * How the user signs in: one flow, or several. With several, each flow's `kinds` and `when`
   * decide where it applies (DHL: the German account by pasted link, the Dutch one by password);
   * the first applicable one is the default.
   */
  readonly signIn: SignInFlow<Config, Secret> | readonly SignInFlow<Config, Secret>[];
  readonly http: HttpPolicy;
  /** Account and shop sources: return everything the account lists. */
  fetchAccount?(context: PluginContext<Config, Secret>): Promise<FetchResult>;
  /** Tracking sources: look up these codes. A missing code in the result means "not found". */
  track?(context: PluginContext<Config, Secret>, barcodes: readonly string[]): Promise<FetchResult>;
  /**
   * Reads the courier map for one parcel. Returns null when there is no session. Must not sign
   * in again on a network error; renewing a token the carrier explicitly refused, once, is fine.
   */
  readLive?(
    context: PluginContext<Config, Secret>,
    target: LiveTarget,
  ): Promise<LiveReading | null>;
}

/** Identity helper that keeps the generic parameters inferred from the schemas. */
export function defineCarrier<Config, Secret>(
  plugin: CarrierPlugin<Config, Secret>,
): CarrierPlugin<Config, Secret> {
  return plugin;
}
