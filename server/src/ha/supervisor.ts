import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import type { Logger } from "pino";
import type { AuthStore } from "../auth/store.js";

/** Ingress port the Home Assistant app declares; the Supervisor proxies the web UI to it. */
export const APP_INGRESS_PORT = 8099;
const SUPERVISOR_URL = "http://supervisor";
/** Integration domain the app announces itself to. */
export const DISCOVERY_SERVICE = "open_parcels";
const DISCOVERY_TOKEN_NAME = "Home Assistant (discovery)";

/** Options shown in the app's configuration tab; each maps to an OPENPARCELS_* variable. */
const optionsSchema = z
  .object({
    log_level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
    timezone: z.string().optional(),
    public_url: z.string().optional(),
    archive_days: z.number().int().optional(),
    delete_days: z.number().int().optional(),
    quiet_window: z.boolean().optional(),
  })
  .loose();

/** True when running as a Home Assistant app: the Supervisor injects its token. */
export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env["SUPERVISOR_TOKEN"];
  return token !== undefined && token !== "";
}

/**
 * Environment additions for a supervised start: the app's options become OPENPARCELS_* variables
 * (explicit environment variables still win) and the ingress listener is switched on.
 */
export function supervisedEnvironment(
  env: NodeJS.ProcessEnv,
  optionsFile = "/data/options.json",
): NodeJS.ProcessEnv {
  const options = existsSync(optionsFile)
    ? optionsSchema.parse(JSON.parse(readFileSync(optionsFile, "utf8")))
    : {};
  const mapped: Record<string, string | undefined> = {
    OPENPARCELS_LOG_LEVEL: options.log_level,
    OPENPARCELS_TIMEZONE: options.timezone,
    OPENPARCELS_PUBLIC_URL: options.public_url,
    OPENPARCELS_ARCHIVE_DAYS: options.archive_days?.toString(),
    OPENPARCELS_DELETE_DAYS: options.delete_days?.toString(),
    OPENPARCELS_QUIET_WINDOW: options.quiet_window?.toString(),
    OPENPARCELS_INGRESS_PORT: String(APP_INGRESS_PORT),
    OPENPARCELS_DATA_DIR: "/data",
  };
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== undefined && value !== "" && result[key] === undefined) {
      result[key] = value;
    }
  }
  return result;
}

export interface DiscoveryOptions {
  readonly token: string;
  readonly auth: AuthStore;
  readonly port: number;
  readonly logger: Logger;
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Announces this app to Home Assistant, so the integration can be set up with one click. The
 * payload carries a fresh API token made only for this; the previous one is revoked on each start.
 */
export async function announceToHomeAssistant(options: DiscoveryOptions): Promise<void> {
  for (const existing of await options.auth.listTokens()) {
    if (existing.name === DISCOVERY_TOKEN_NAME) {
      await options.auth.deleteToken(existing.id);
    }
  }
  const { token } = await options.auth.createToken(DISCOVERY_TOKEN_NAME, ["read", "write"], null);
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await send(`${SUPERVISOR_URL}/discovery`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      service: DISCOVERY_SERVICE,
      config: { host: hostname(), port: options.port, api_token: token },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    options.logger.warn(
      { status: response.status },
      "Home Assistant did not accept the discovery message.",
    );
    return;
  }
  options.logger.info(
    "Announced to Home Assistant; the integration can now be added from its notification.",
  );
}
