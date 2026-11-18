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

export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
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
