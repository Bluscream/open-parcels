import {
  RateLimitedError,
  restoreJar,
  serializeJar,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { charge, exhaust, msUntilToken, spend } from "./budget.js";
import { BUDGET_REFILL_MS, MIN_CYCLE_GAP_MS, TRACKED_CODE_SOFT_LIMIT } from "./keys.js";
import { mergeAnswers, type Answer } from "./merge.js";
import { normalizeOfficial } from "./official-normalize.js";
import { OfficialSession, type Credentials } from "./official.js";
import { BotGuardError, lookUpPublic, type Counter } from "./public.js";
import { normalizePublic } from "./public-normalize.js";
import { BUDGET_RULES, fetchQueue, loadState, standdownMs, type UpsState } from "./state.js";

type Context = PluginContext<unknown, unknown>;

/** Pasted codes lose spaces and are upper-cased; anything that cannot be a UPS number is skipped. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}
const PLAUSIBLE = /^[A-Z0-9]{8,35}$/;

/** Why the public tracking was not asked this run; none of these is a failure. */
function holdReason(state: UpsState, now: number): string | null {
  if (state.standdownUntil !== null && now < state.standdownUntil) {
    return "standing down after a failed lookup";
  }
  if (state.lastPublicAt !== null && now - state.lastPublicAt < MIN_CYCLE_GAP_MS) {
    return "too soon after the last lookup";
  }
  return null;
}

function warnAboutQueue(context: Context, state: UpsState, waiting: number): void {
  if (waiting <= TRACKED_CODE_SOFT_LIMIT) {
    state.warnedSoftLimit = false;
    return;
  }
  if (!state.warnedSoftLimit) {
    state.warnedSoftLimit = true;
    context.logger.warn(
      { waiting, hoursPerRound: Math.round((waiting * BUDGET_REFILL_MS) / 3_600_000) },
      "UPS allows about one public lookup per 75 minutes; with this many parcels each refreshes rarely.",
    );
  }
}

/** Records a failed public lookup: a stand-down, and an empty budget when the guard hung. */
function recordFailure(state: UpsState, error: unknown, now: number): void {
  state.failures += 1;
  if (error instanceof BotGuardError && error.hung) {
    state.budget = exhaust(now);
  }
  const asked = error instanceof RateLimitedError ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
  state.standdownUntil = now + Math.max(asked, standdownMs(state.failures));
}

/**
 * Spends at most one public lookup, on the code at the head of the queue. Returns null when the
 * run may not ask (budget spent, standing down, too soon): that is a quiet skip, not an error.
 */
async function askPublic(
  context: Context,
  state: UpsState,
  codes: readonly string[],
  locale: string,
): Promise<{ code: string; detail: Json | null } | null> {
  const now = context.clock.now().getTime();
  const hold = holdReason(state, now);
  const queue = fetchQueue(state, codes, now);
  warnAboutQueue(context, state, queue.length);
  const head = queue[0];
  if (hold !== null || head === undefined) {
    context.logger.debug({ reason: hold }, "UPS public tracking not asked this run.");
    return null;
  }
  const spent = spend(state.budget, BUDGET_RULES, now);
  if (spent === null) {
    const waitMs = msUntilToken(state.budget, BUDGET_RULES, now);
    context.logger.debug({ waitMs }, "UPS request budget spent; not asking this run.");
    return null;
  }
  // Stamped before the request goes out: an attempt counts whether or not it comes back.
  state.budget = spent;
  state.lastPublicAt = now;
  state.codes[head] = { lastFetch: now, status: state.codes[head]?.status ?? null };
  const jar = restoreJar(state.jar);
  const counter: Counter = { sent: 0 };
  try {
    const detail = await lookUpPublic(context, jar, head, locale, counter);
    state.failures = 0;
    state.standdownUntil = null;
    return { code: head, detail };
  } catch (error) {
    recordFailure(state, error, now);
    throw error;
  } finally {
    // A 401 retry sends a second request the token above did not cover.
    for (let extra = counter.sent - 1; extra > 0; extra -= 1) {
      state.budget = charge(state.budget, BUDGET_RULES, now);
    }
    state.jar = serializeJar(jar);
  }
}

async function askOfficial(
  session: OfficialSession,
  context: Context,
  codes: readonly string[],
  locale: string,
  answers: Map<string, Answer[]>,
): Promise<void> {
  for (const code of codes) {
    const pkg = await session.track(code);
    if (pkg !== null) {
      answers.get(code)?.push({
        backend: "official",
        parcel: normalizeOfficial(context, code, pkg, locale),
      });
    }
  }
}

/**
 * Looks codes up. With the user's developer key every code goes to UPS's official API; the public
 * tracking is asked for one code per run at most, within its request budget, and both answers
 * are merged. Without a key a run covers only the code at the head of the queue, so the result is
 * complete only when that was every code.
 */
export async function trackCodes(
  context: Context,
  credentials: Credentials | null,
  barcodes: readonly string[],
  locale: string,
): Promise<FetchResult> {
  const codes = [...new Set(barcodes.map(normalizeCode))].filter((c) => PLAUSIBLE.test(c));
  const state = loadState(context.session.load(), context.clock.now().getTime());
  state.codes = Object.fromEntries(Object.entries(state.codes).filter(([c]) => codes.includes(c)));
  const answers = new Map(codes.map((code) => [code, [] as Answer[]]));
  const official =
    credentials === null ? null : new OfficialSession(context, credentials, state.token);
  let askedPublic: string | null = null;
  try {
    if (official !== null) {
      await askOfficial(official, context, codes, locale, answers);
    }
    try {
      const fromPublic = await askPublic(context, state, codes, locale);
      askedPublic = fromPublic?.code ?? null;
      if (fromPublic !== null && fromPublic.detail !== null) {
        const parcel = normalizePublic(context, fromPublic.code, fromPublic.detail, locale);
        answers.get(fromPublic.code)?.unshift({ backend: "public", parcel });
      }
    } catch (error) {
      // With the official API's answers in hand, a public failure only costs the merge.
      if (official === null) {
        throw error;
      }
      context.logger.warn(
        { error: String(error) },
        "UPS public tracking failed; using the official API alone.",
      );
    }
  } finally {
    state.token = official?.token ?? state.token;
    await context.session.save(state);
  }
  const snapshots: ParcelSnapshot[] = [];
  for (const [code, list] of answers) {
    const merged = mergeAnswers(list);
    if (merged !== null) {
      snapshots.push(merged);
      const seen = state.codes[code];
      if (seen !== undefined) {
        seen.status = merged.status;
      }
    }
  }
  await context.session.save(state);
  const complete = official !== null || (codes.length === 1 && askedPublic === codes[0]);
  return { snapshots, complete };
}
