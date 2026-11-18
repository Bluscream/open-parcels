import path from "node:path";
import { z } from "zod";
import { isValidTimeZone } from "./engine/tz.js";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

/**
 * Environment variables the server reads. Everything is prefixed with OPENPARCELS_ so the
 * container never picks up unrelated variables by accident.
 */
const envSchema = z.object({
  OPENPARCELS_DATA_DIR: z.string().min(1).default("/data"),
  OPENPARCELS_HOST: z.string().min(1).default("0.0.0.0"),
  OPENPARCELS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OPENPARCELS_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** Base64 of 32 random bytes. When unset, a key file in the data directory is used. */
  OPENPARCELS_SECRET_KEY: z.string().min(1).optional(),
  /** Public base URL, used for links in calendar feeds and diagnostics. */
  OPENPARCELS_PUBLIC_URL: z.url().optional(),
  /** Port of the separate Home Assistant ingress listener. Unset disables it. */
  OPENPARCELS_INGRESS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Mark session cookies Secure. Turn on when served over HTTPS. */
  OPENPARCELS_SECURE_COOKIES: booleanFlag.default(false),
  /** Days after delivery before a parcel is archived, and days after archiving before it is deleted. */
  OPENPARCELS_ARCHIVE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  OPENPARCELS_DELETE_DAYS: z.coerce.number().int().min(1).max(36500).default(365),
  /** IANA time zone for the night-time quiet window and calendar days. Defaults to TZ / the system zone. */
  OPENPARCELS_TIMEZONE: z
    .string()
    .min(1)
    .refine(isValidTimeZone, "Unknown time zone; use an IANA name like Europe/Berlin.")
    .optional(),
});

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly secretKey: string | undefined;
  readonly publicUrl: URL | undefined;
  readonly ingressPort: number | undefined;
  readonly secureCookies: boolean;
  readonly timeZone: string;
  readonly retention: {
    readonly archiveAfterDays: number;
    readonly deleteAfterDays: number;
    readonly rawAfterDays: number;
  };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Parses the environment once at start-up; any invalid value stops the process with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}.`);
  }
  const values = parsed.data;
  const dataDir = path.resolve(values.OPENPARCELS_DATA_DIR);
  return {
    dataDir,
    databasePath: path.join(dataDir, "openparcels.db"),
    host: values.OPENPARCELS_HOST,
    port: values.OPENPARCELS_PORT,
    logLevel: values.OPENPARCELS_LOG_LEVEL,
    secretKey: values.OPENPARCELS_SECRET_KEY,
    publicUrl:
      values.OPENPARCELS_PUBLIC_URL === undefined
        ? undefined
        : new URL(values.OPENPARCELS_PUBLIC_URL),
    ingressPort: values.OPENPARCELS_INGRESS_PORT,
    secureCookies: values.OPENPARCELS_SECURE_COOKIES,
    timeZone: values.OPENPARCELS_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    retention: {
      archiveAfterDays: values.OPENPARCELS_ARCHIVE_DAYS,
      deleteAfterDays: values.OPENPARCELS_DELETE_DAYS,
      rawAfterDays: values.OPENPARCELS_ARCHIVE_DAYS,
    },
  };
}
