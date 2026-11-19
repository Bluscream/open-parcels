import path from "node:path";
import { z } from "zod";
import { isValidTimeZone } from "./engine/tz.js";
import {
  BASE_LAYER_CHOICES,
  OVERLAY_CHOICES,
  templateProblem,
  type CustomProvider,
} from "./tiles/layers.js";
import { TILE_MAX_ZOOM_ANY } from "./tiles/proxy.js";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((value) => value === "true" || value === "1" || value === "yes");

const port = z.coerce.number().int().min(1).max(65535);

/**
 * How a change made in the UI takes effect:
 * - `env`: only from the environment, because it is needed before the database (where UI changes
 *   are kept) opens, or because a wrong value would lock the UI out that could undo it.
 * - `restart`: saved now, used from the next start on.
 * - `live`: used at once by the running server.
 */
export type ApplyMode = "env" | "restart" | "live";
export type SettingValue = string | number | boolean;
export type SettingKind = "string" | "number" | "boolean";

interface SettingDef<S extends z.ZodType<SettingValue | undefined>> {
  readonly group: string;
  readonly description: string;
  /** Parses the text form of the value, as it comes from the environment. */
  readonly schema: S;
  /** Used when the environment does not set the variable; undefined means unset. */
  readonly default: z.output<S>;
  readonly apply: ApplyMode;
  readonly kind: SettingKind;
  /** The value never leaves the server. */
  readonly secret?: boolean;
  readonly choices?: readonly string[];
}

function setting<S extends z.ZodType<SettingValue | undefined>>(def: SettingDef<S>): SettingDef<S> {
  return def;
}

/**
 * Every environment variable the server reads, prefixed with OPENPARCELS_ so the container never
 * picks up unrelated variables by accident. The environment is the base layer (the Home Assistant
 * app passes its options this way); values saved on the Settings page win over it until reset.
 */
export const SETTINGS = {
  OPENPARCELS_DATA_DIR: setting({
    group: "Storage",
    description: "Folder for the database, encryption key and caches.",
    schema: z.string().min(1),
    default: "/data",
    apply: "env",
    kind: "string",
  }),
  OPENPARCELS_SECRET_KEY: setting({
    group: "Storage",
    description:
      "Base64 of 32 random bytes that encrypts stored credentials. Unset uses a key file in the data folder.",
    schema: z.string().min(1).optional(),
    default: undefined,
    apply: "env",
    kind: "string",
    secret: true,
  }),
  OPENPARCELS_WEB_DIR: setting({
    group: "Server",
    description:
      "Folder with the built web UI. Unset uses web/dist next to the server; missing means API only.",
    schema: z.string().min(1).optional(),
    default: undefined,
    apply: "env",
    kind: "string",
  }),
  OPENPARCELS_HOST: setting({
    group: "Server",
    description: "Address the server listens on.",
    schema: z.string().min(1),
    default: "0.0.0.0",
    apply: "env",
    kind: "string",
  }),
  OPENPARCELS_PORT: setting({
    group: "Server",
    description: "Port of the web UI and API.",
    schema: port,
    default: 3000,
    apply: "env",
    kind: "number",
  }),
  OPENPARCELS_INGRESS_PORT: setting({
    group: "Server",
    description: "Port of the separate Home Assistant ingress listener. Unset disables it.",
    schema: port.optional(),
    default: undefined,
    apply: "env",
    kind: "number",
  }),
  OPENPARCELS_TRUST_PROXY: setting({
    group: "Server",
    description:
      "Reverse proxies whose X-Forwarded-For is believed, so the sign-in throttle sees real client addresses: comma-separated addresses or CIDR ranges. Unset trusts nobody; never list addresses clients could connect from directly.",
    schema: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => value.split(",").every((part) => /^[\da-f.:]+(\/\d+)?$/i.test(part.trim())),
        "List proxy addresses or CIDR ranges, separated by commas.",
      )
      .optional(),
    default: undefined,
    apply: "restart",
    kind: "string",
  }),
  OPENPARCELS_SECURE_COOKIES: setting({
    group: "Server",
    description:
      "Mark session cookies Secure. Turn on when served over HTTPS only. Environment only: " +
      "turned on over plain HTTP it would block the sign-in needed to turn it off again.",
    schema: booleanFlag,
    default: false,
    apply: "env",
    kind: "boolean",
  }),
  OPENPARCELS_PUBLIC_URL: setting({
    group: "Server",
    description: "Public base URL, used for links in calendar feeds.",
    schema: z.url().optional(),
    default: undefined,
    apply: "live",
    kind: "string",
  }),
  OPENPARCELS_LOG_LEVEL: setting({
    group: "Server",
    description: "How much the server logs.",
    schema: z.enum(LOG_LEVELS),
    default: "info",
    apply: "live",
    kind: "string",
    choices: LOG_LEVELS,
  }),
  OPENPARCELS_TIMEZONE: setting({
    group: "Tracking",
    description:
      "IANA time zone (e.g. Europe/Berlin) for the night-time quiet window, mail dates and calendar days. Unset uses TZ / the system zone.",
    schema: z
      .string()
      .min(1)
      .refine(isValidTimeZone, "Unknown time zone; use an IANA name like Europe/Berlin.")
      .optional(),
    default: undefined,
    apply: "restart",
    kind: "string",
  }),
  OPENPARCELS_QUIET_WINDOW: setting({
    group: "Tracking",
    description: "Pause carrier polling 00:00–06:00 local time. Turn off to poll all night.",
    schema: booleanFlag,
    default: true,
    apply: "live",
    kind: "boolean",
  }),
  OPENPARCELS_ARCHIVE_DAYS: setting({
    group: "Retention",
    description:
      "Days after delivery before a parcel is archived and its raw carrier data dropped.",
    schema: z.coerce.number().int().min(1).max(3650),
    default: 30,
    apply: "live",
    kind: "number",
  }),
  OPENPARCELS_DELETE_DAYS: setting({
    group: "Retention",
    description: "Days after archiving before a parcel is deleted.",
    schema: z.coerce.number().int().min(1).max(36500),
    default: 365,
    apply: "live",
    kind: "number",
  }),
  OPENPARCELS_NOT_FOUND_ARCHIVE_DAYS: setting({
    group: "Retention",
    description:
      "Days a carrier may answer “not found” for an undelivered parcel before it is archived; 0 never.",
    schema: z.coerce.number().int().min(0).max(3650),
    default: 30,
    apply: "live",
    kind: "number",
  }),
  OPENPARCELS_MAP_BASE_LAYER: setting({
    group: "Map",
    description:
      "Map style shown until a user picks another on the map: map, topographic, satellite, borders only, or the custom provider.",
    schema: z.enum(BASE_LAYER_CHOICES),
    default: "osm",
    apply: "live",
    kind: "string",
    choices: BASE_LAYER_CHOICES,
  }),
  OPENPARCELS_MAP_OVERLAY: setting({
    group: "Map",
    description: "Overlay drawn over the map style by default; labels suit satellite imagery.",
    schema: z.enum(OVERLAY_CHOICES),
    default: "none",
    apply: "live",
    kind: "string",
    choices: OVERLAY_CHOICES,
  }),
  OPENPARCELS_MAP_CUSTOM_URL: setting({
    group: "Map",
    description:
      "Custom tile provider, e.g. https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}. Needs https and {z}, {x}, {y}; {s}, {r} and {key} are filled in by the server.",
    schema: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .superRefine((value, context) => {
        const problem = templateProblem(value);
        if (problem !== null) context.addIssue({ code: "custom", message: problem });
      })
      .optional(),
    default: undefined,
    apply: "live",
    kind: "string",
  }),
  OPENPARCELS_MAP_CUSTOM_KEY: setting({
    group: "Map",
    description: "API key for the custom provider's {key}. Stays on the server.",
    schema: z.string().trim().min(1).max(500).optional(),
    default: undefined,
    apply: "live",
    kind: "string",
    secret: true,
  }),
  OPENPARCELS_MAP_CUSTOM_ATTRIBUTION: setting({
    group: "Map",
    description: "Credit shown on the map for the custom provider, as its terms require.",
    schema: z.string().trim().min(1).max(300).optional(),
    default: undefined,
    apply: "live",
    kind: "string",
  }),
  OPENPARCELS_MAP_CUSTOM_MAX_ZOOM: setting({
    group: "Map",
    description: "Deepest zoom the custom provider serves; the map scales up beyond it.",
    schema: z.coerce.number().int().min(0).max(TILE_MAX_ZOOM_ANY),
    default: 19,
    apply: "live",
    kind: "number",
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export type SettingValues = {
  -readonly [K in SettingKey]: z.output<(typeof SETTINGS)[K]["schema"]>;
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export type ParseResult =
  | { readonly ok: true; readonly value: SettingValue | undefined }
  | { readonly ok: false; readonly error: string };

/** Parses one value in its text form (environment) or typed form (saved in the UI). */
export function parseSetting(key: SettingKey, raw: unknown): ParseResult {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return { ok: false, error: `${key}: expected text, a number or true/false.` };
  }
  const parsed = SETTINGS[key].schema.safeParse(String(raw));
  if (!parsed.success) {
    return {
      ok: false,
      error: `${key}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** The environment's values and whether each came from the environment or the default. */
export interface ParsedEnv {
  readonly values: Readonly<SettingValues>;
  readonly sources: Readonly<Record<SettingKey, "env" | "default">>;
}

export function parseEnv(env: NodeJS.ProcessEnv): ParsedEnv {
  const values: Record<string, unknown> = {};
  const sources: Record<string, "env" | "default"> = {};
  const problems: string[] = [];
  for (const key of SETTING_KEYS) {
    const raw = env[key];
    if (raw === undefined) {
      values[key] = SETTINGS[key].default;
      sources[key] = "default";
      continue;
    }
    const parsed = parseSetting(key, raw);
    if (parsed.ok) {
      values[key] = parsed.value;
      sources[key] = "env";
    } else {
      problems.push(parsed.error);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}.`);
  }
  // Every value came through its own schema or is its declared default.
  return {
    values: values as SettingValues,
    sources: sources as Record<SettingKey, "env" | "default">,
  };
}

/** False, or the proxy addresses and ranges whose X-Forwarded-For is believed. */
export type TrustProxy = false | readonly string[];

function parseTrustProxy(value: string | undefined): TrustProxy {
  return value === undefined ? false : value.split(",").map((part) => part.trim());
}

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  /** The environment as parsed at start-up; the base layer under settings saved in the UI. */
  readonly env: ParsedEnv;
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
  readonly quietWindow: boolean;
  readonly webDir: string | undefined;
  readonly trustProxy: TrustProxy;
  readonly retention: {
    readonly archiveAfterDays: number;
    readonly deleteAfterDays: number;
    readonly rawAfterDays: number;
    readonly notFoundArchiveDays: number;
  };
  readonly map: {
    readonly baseLayer: (typeof BASE_LAYER_CHOICES)[number];
    readonly overlay: (typeof OVERLAY_CHOICES)[number];
    /** Unset without a template. */
    readonly custom: CustomProvider | undefined;
  };
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Builds the config the server reads from a full set of setting values. */
export function toConfig(values: Readonly<SettingValues>, env: ParsedEnv): AppConfig {
  const dataDir = path.resolve(values.OPENPARCELS_DATA_DIR);
  return {
    env,
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
    quietWindow: values.OPENPARCELS_QUIET_WINDOW,
    webDir:
      values.OPENPARCELS_WEB_DIR === undefined
        ? undefined
        : path.resolve(values.OPENPARCELS_WEB_DIR),
    trustProxy: parseTrustProxy(values.OPENPARCELS_TRUST_PROXY),
    retention: {
      archiveAfterDays: values.OPENPARCELS_ARCHIVE_DAYS,
      deleteAfterDays: values.OPENPARCELS_DELETE_DAYS,
      rawAfterDays: values.OPENPARCELS_ARCHIVE_DAYS,
      notFoundArchiveDays: values.OPENPARCELS_NOT_FOUND_ARCHIVE_DAYS,
    },
    map: {
      baseLayer: values.OPENPARCELS_MAP_BASE_LAYER,
      overlay: values.OPENPARCELS_MAP_OVERLAY,
      custom:
        values.OPENPARCELS_MAP_CUSTOM_URL === undefined
          ? undefined
          : {
              url: values.OPENPARCELS_MAP_CUSTOM_URL,
              apiKey: values.OPENPARCELS_MAP_CUSTOM_KEY,
              attribution: values.OPENPARCELS_MAP_CUSTOM_ATTRIBUTION,
              maxZoom: values.OPENPARCELS_MAP_CUSTOM_MAX_ZOOM,
            },
    },
  };
}

/** Parses the environment once at start-up; any invalid value stops the process with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = parseEnv(env);
  return toConfig(parsed.values, parsed);
}
