import { z } from "zod";
import type { ParcelStatus } from "../../plugin/api.js";
import { restoreBudget, type Budget, type BudgetRules } from "./budget.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BUDGET_CAPACITY,
  BUDGET_REFILL_MS,
  MIN_OVERDUE_INTERVALS,
} from "./keys.js";
import { tokenSchema, type StoredToken } from "./official.js";

export const BUDGET_RULES: BudgetRules = { capacity: BUDGET_CAPACITY, refillMs: BUDGET_REFILL_MS };

/** What one source remembers between runs. Kept in the encrypted session store. */
export interface UpsState {
  budget: Budget;
  /** Consecutive failed public lookups, for the stand-down. */
  failures: number;
  /** Epoch ms before which the public tracking is not asked again. */
  standdownUntil: number | null;
  /** Epoch ms of the last public lookup, for the minimum gap between them. */
  lastPublicAt: number | null;
  /** Per code that was asked at least once: when, and the status it had. */
  codes: Record<string, { lastFetch: number; status: ParcelStatus | null }>;
  warnedSoftLimit: boolean;
  /** The public tracking's cookie jar, serialised. */
  jar: unknown;
  token: StoredToken | null;
}

const storedSchema = z.object({
  budget: z.unknown(),
  failures: z.number().int().nonnegative().catch(0),
  standdownUntil: z.number().nullable().catch(null),
  lastPublicAt: z.number().nullable().catch(null),
  codes: z
    .record(z.string(), z.object({ lastFetch: z.number(), status: z.string().nullable() }))
    .catch({}),
  warnedSoftLimit: z.boolean().catch(false),
  jar: z.unknown(),
  token: tokenSchema.nullable().catch(null),
});

/** Restores the state; anything unreadable starts fresh, with a full budget. */
export function loadState(stored: unknown, now: number): UpsState {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success) {
    return {
      budget: restoreBudget(null, BUDGET_RULES, now),
      failures: 0,
      standdownUntil: null,
      lastPublicAt: null,
      codes: {},
      warnedSoftLimit: false,
      jar: null,
      token: null,
    };
  }
  const data = parsed.data;
  return {
    ...data,
    budget: restoreBudget(data.budget, BUDGET_RULES, now),
    codes: data.codes as UpsState["codes"],
    jar: data.jar ?? null,
  };
}

/** The stand-down after the `failures`-th failed lookup in a row; never shorter than a refill. */
export function standdownMs(failures: number): number {
  return Math.max(Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_CAP_MS), BUDGET_REFILL_MS);
}

/** Which code earns the next request: ordered by how soon each state can plausibly change. */
const PRIORITY: readonly (ParcelStatus | null)[] = [
  "out_for_delivery",
  "problem",
  "returning",
  "in_transit",
  "registered",
  "unknown",
  null,
  "at_pickup_point",
];

/**
 * The codes in the order they deserve the next request. A code never asked comes first (the user
 * just added it); then a code that has fallen a whole rotation behind, oldest first, whatever its
 * status; then status, then staleness. The overdue band, sized from the queue, is what stops one
 * busy parcel from taking every request while the others starve.
 */
export function fetchQueue(state: UpsState, codes: readonly string[], now: number): string[] {
  const maxOverdue = Math.max(MIN_OVERDUE_INTERVALS, codes.length + 1);
  const key = (code: string): [number, number, number, number] => {
    const seen = state.codes[code];
    if (seen === undefined) {
      return [0, 0, 0, 0];
    }
    const overdue = Math.min(Math.floor((now - seen.lastFetch) / BUDGET_REFILL_MS), maxOverdue);
    const rank = PRIORITY.indexOf(seen.status);
    return [1, -overdue, rank === -1 ? PRIORITY.length : rank, seen.lastFetch];
  };
  const keyed = codes.map((code) => ({ code, key: key(code) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < 4; i += 1) {
      const diff = (a.key[i] ?? 0) - (b.key[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  });
  return keyed.map((entry) => entry.code);
}
