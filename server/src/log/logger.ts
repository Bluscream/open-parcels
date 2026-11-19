import { pino, type Logger, type LoggerOptions } from "pino";
import type { LogLevel } from "../config.js";
import { redactText, SECRET_KEYS } from "./redact.js";

/** pino redact paths: every secret key at the top level and up to two levels deep. */
function secretPaths(): string[] {
  const paths: string[] = [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
  ];
  for (const key of SECRET_KEYS) {
    const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(key);
    const segment = isIdentifier ? `.${key}` : `["${key}"]`;
    paths.push(isIdentifier ? key : segment, `*${segment}`, `*.*${segment}`);
  }
  return paths;
}

/** Paths whose segments after the prefix are credentials: the ICS feed token, the signed image id. */
const SECRET_PATH_PREFIXES = [
  { prefix: "/ical/", pattern: "/ical/:token.ics" },
  { prefix: "/img/", pattern: "/img/:file" },
] as const;

/**
 * The path a log line may show: the query string is dropped (it can carry tokens), and a path
 * under a secret prefix is reduced to its route pattern, matched or not, with or without ingress.
 */
export function loggablePath(url: string): string {
  const path = url.split("?", 1)[0] ?? "";
  for (const { prefix, pattern } of SECRET_PATH_PREFIXES) {
    const index = path.indexOf(prefix);
    if (index !== -1) {
      return path.slice(0, index) + pattern;
    }
  }
  return path;
}

interface LoggedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly ip?: string;
  readonly routeOptions?: { readonly url?: string };
}

function serializeRequest(req: LoggedRequest): Record<string, unknown> {
  const route = req.routeOptions?.url;
  return {
    method: req.method,
    url: loggablePath(route ?? req.url ?? ""),
    remoteAddress: req.ip,
  };
}

/** Error messages and stacks can quote a URL, a code or an address; scrub both. */
function serializeError(err: unknown): unknown {
  const serialized = pino.stdSerializers.err(err as Error) as unknown;
  if (serialized === null || typeof serialized !== "object") {
    return serialized;
  }
  const result: Record<string, unknown> = { ...(serialized as Record<string, unknown>) };
  for (const key of ["message", "stack"] as const) {
    const value = result[key];
    if (typeof value === "string") {
      result[key] = redactText(value);
    }
  }
  return result;
}

export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    serializers: { req: serializeRequest, err: serializeError },
    redact: { paths: secretPaths(), censor: "[redacted]" },
    formatters: {
      // Free text can carry emails, tracking numbers or coordinates; scrub it before it is written.
      log(object: Record<string, unknown>): Record<string, unknown> {
        const scrubbed: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) {
          scrubbed[key] = typeof value === "string" ? redactText(value) : value;
        }
        return scrubbed;
      },
    },
    hooks: {
      logMethod(args, method) {
        const [first, ...rest] = args;
        if (typeof first === "string") {
          method.apply(this, [redactText(first), ...rest]);
          return;
        }
        method.apply(this, args);
      },
    },
  };
}

export function createLogger(level: LogLevel): Logger {
  return pino(loggerOptions(level));
}

export type { Logger };
