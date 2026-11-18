import { createHash } from "node:crypto";
import {
  asObject,
  num,
  text,
  TransientError,
  UnexpectedResponseError,
} from "../../../plugin/api.js";

/**
 * Mój DHL guards its public calls with an Altcha challenge: a proof of work any client is meant
 * to compute (find the number whose SHA-256 with the salt matches), not a human test. The search
 * is bounded twice: by the challenge's own `maxnumber` (capped) and by a CPU-time budget, so a
 * hostile or changed challenge can never pin the server.
 */
export const MAX_NUMBER_CAP = 2_000_000;
export const DEFAULT_BUDGET_MS = 4_000;
const CHECK_EVERY = 2_048;

export interface SolveOptions {
  readonly budgetMs?: number;
  /** Elapsed-time source; tests replace it. */
  readonly elapsed?: () => number;
}

/** The base64 JSON payload the website posts as `captcha-payload`. */
export function solveAltcha(challenge: unknown, options: SolveOptions = {}): string {
  const entry = asObject(challenge);
  const salt = text(entry["salt"], { numbers: false });
  const target = text(entry["challenge"], { numbers: false })?.toLowerCase() ?? null;
  const algorithm = text(entry["algorithm"], { numbers: false });
  const signature = text(entry["signature"], { numbers: false });
  const maximum = num(entry["maxnumber"]);
  if (
    salt === null ||
    target === null ||
    signature === null ||
    algorithm?.toUpperCase() !== "SHA-256" ||
    maximum === null ||
    !Number.isInteger(maximum) ||
    maximum < 0
  ) {
    throw new UnexpectedResponseError("Mój DHL sent an Altcha challenge of an unknown shape.");
  }
  if (maximum > MAX_NUMBER_CAP) {
    throw new UnexpectedResponseError("Mój DHL's Altcha challenge asks for too much work.");
  }
  const started = performance.now();
  const elapsed = options.elapsed ?? (() => performance.now() - started);
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  for (let number = 0; number <= maximum; number += 1) {
    if (number % CHECK_EVERY === 0 && elapsed() > budget) {
      throw new TransientError("Mój DHL's Altcha challenge took too long to solve.");
    }
    if (
      createHash("sha256")
        .update(`${salt}${String(number)}`)
        .digest("hex") === target
    ) {
      const payload = { algorithm, challenge: target, number, salt, signature };
      return Buffer.from(JSON.stringify(payload)).toString("base64");
    }
  }
  throw new UnexpectedResponseError("Mój DHL's Altcha challenge has no solution.");
}
