/**
 * The request allowance UPS grants an address on its public tracking, kept as tokens. Only the
 * number of requests matters, not their spacing, so pacing is accounted rather than delayed. Wall
 * clock and persisted, so a restart does not hand out a fresh allowance.
 */
export interface Budget {
  readonly tokens: number;
  /** Epoch ms the refill is counted from. */
  readonly updatedAt: number;
}

export interface BudgetRules {
  readonly capacity: number;
  readonly refillMs: number;
}

/** A budget nobody has spent against yet starts full. */
export function fullBudget(rules: BudgetRules, now: number): Budget {
  return { tokens: rules.capacity, updatedAt: now };
}

/** Adds the whole tokens earned since `updatedAt`. */
export function accrue(budget: Budget, rules: BudgetRules, now: number): Budget {
  const elapsed = now - budget.updatedAt;
  if (elapsed < 0) {
    // The clock went backwards: re-anchor rather than bank the skew as credit.
    return { tokens: budget.tokens, updatedAt: now };
  }
  if (elapsed < rules.refillMs) {
    // Anchored on whole tokens only, or every call drops a remainder and nothing ever refills.
    return budget;
  }
  const earned = Math.floor(elapsed / rules.refillMs);
  const tokens = Math.min(rules.capacity, budget.tokens + earned);
  // Re-anchored when full, so an idle week does not bank a week of credit.
  const updatedAt = tokens >= rules.capacity ? now : budget.updatedAt + earned * rules.refillMs;
  return { tokens, updatedAt };
}

export function available(budget: Budget, rules: BudgetRules, now: number): number {
  return Math.floor(accrue(budget, rules, now).tokens);
}

/**
 * Spends one token, or returns null when there is none. The refill restarts at this request: the
 * measured beat is the gap between two answered requests, so a banked token spent late must not
 * put the next request less than a beat after this one.
 */
export function spend(budget: Budget, rules: BudgetRules, now: number): Budget | null {
  const current = accrue(budget, rules, now);
  if (current.tokens < 1) {
    return null;
  }
  return { tokens: current.tokens - 1, updatedAt: Math.max(current.updatedAt, now) };
}

/** Charges a request the budget did not plan for (a retry), never going below zero. */
export function charge(budget: Budget, rules: BudgetRules, now: number): Budget {
  return spend(budget, rules, now) ?? { tokens: 0, updatedAt: now };
}

/** The address closed although tokens were left: the estimate was wrong, so nothing is left. */
export function exhaust(now: number): Budget {
  return { tokens: 0, updatedAt: now };
}

/** Milliseconds until a token can be spent. */
export function msUntilToken(budget: Budget, rules: BudgetRules, now: number): number {
  const current = accrue(budget, rules, now);
  return current.tokens >= 1 ? 0 : Math.max(0, current.updatedAt + rules.refillMs - now);
}

/** Restores a stored balance; anything odd gives a full budget. Capacity always comes from code. */
export function restoreBudget(stored: unknown, rules: BudgetRules, now: number): Budget {
  if (stored === null || typeof stored !== "object") {
    return fullBudget(rules, now);
  }
  const { tokens, updatedAt } = stored as Record<string, unknown>;
  if (typeof tokens !== "number" || typeof updatedAt !== "number" || updatedAt <= 0 || tokens < 0) {
    return fullBudget(rules, now);
  }
  return { tokens: Math.min(rules.capacity, tokens), updatedAt };
}
