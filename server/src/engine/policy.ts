import type { ParcelStatus } from "../domain/parcel.js";
import { localParts, nextLocalMidnight, zonedTime } from "./tz.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const POLL_HOT_MS = 15 * MINUTE;
export const POLL_MID_MS = 45 * MINUTE;
/** Accounts and shops with nothing in flight still poll: that is how they discover new parcels. */
export const POLL_IDLE_MS = 3 * HOUR;
export const HOT_LOOKAHEAD_MS = HOUR;
export const QUIET_START_HOUR = 0;
export const QUIET_END_HOUR = 6;
export const CAPTCHA_PAUSE_MS = 6 * HOUR;
export const RATE_LIMIT_MAX_MS = HOUR;

export interface ActiveParcel {
  readonly status: ParcelStatus;
  readonly plannedFrom: string | null;
}

export interface PollContext {
  readonly now: Date;
  readonly timeZone: string;
  /** Skip polling 00:00–06:00 local time. On by default; one global switch, not per carrier. */
  readonly quietWindow: boolean;
  readonly kind: "account" | "tracking" | "shop" | "mail";
  /** Minutes 0–6, derived from the install and source ids, so installs don't poll in lockstep. */
  readonly staggerMinutes: number;
  readonly active: readonly ActiveParcel[];
  /** The plug-in's fixed interval, which replaces the adaptive one and the quiet window. */
  readonly fixedIntervalMs?: number | null;
}

function isHot(parcel: ActiveParcel, now: Date): boolean {
  if (parcel.status !== "out_for_delivery") {
    return false;
  }
  const from = parcel.plannedFrom === null ? Number.NaN : Date.parse(parcel.plannedFrom);
  return Number.isNaN(from) || now.getTime() >= from - HOT_LOOKAHEAD_MS;
}

/**
 * Moves a run that would fall in the quiet window to its catch-up anchor: 06:00 when the night
 * has started, otherwise local midnight (one catch-up run right before the window).
 * Anchored runs get no stagger.
 */
function respectQuietWindow(now: Date, target: Date, timeZone: string): Date {
  const local = localParts(target, timeZone);
  if (local.hour < QUIET_START_HOUR || local.hour >= QUIET_END_HOUR) {
    return target;
  }
  const nowLocal = localParts(now, timeZone);
  const nightStarted = nowLocal.hour >= QUIET_START_HOUR && nowLocal.hour < QUIET_END_HOUR;
  if (nightStarted) {
    return zonedTime({ ...nowLocal, hour: QUIET_END_HOUR, minute: 0 }, timeZone);
  }
  return nextLocalMidnight(now, timeZone);
}

/** When to poll next after a successful run; null means stop until something changes. */
export function nextRunAfterSuccess(context: PollContext): Date | null {
  const { now, active, kind } = context;
  if (context.fixedIntervalMs !== undefined && context.fixedIntervalMs !== null) {
    return new Date(now.getTime() + context.fixedIntervalMs);
  }
  let interval: number;
  if (active.length === 0) {
    if (kind === "tracking") {
      return null;
    }
    interval = POLL_IDLE_MS;
  } else {
    interval = active.some((parcel) => isHot(parcel, now)) ? POLL_HOT_MS : POLL_MID_MS;
  }
  const target = new Date(now.getTime() + interval + context.staggerMinutes * MINUTE);
  if (!context.quietWindow) {
    return target;
  }
  return respectQuietWindow(now, target, context.timeZone);
}

export type FailureKind =
  "rate_limited" | "captcha" | "transient" | "sign_in_rejected" | "invalid_config";

/**
 * Delay after a failed run; null means stop until the user acts (sign in again, fix settings).
 * `consecutive` counts failures including this one.
 */
export function delayAfterFailure(
  kind: FailureKind,
  consecutive: number,
  retryAfterSeconds?: number,
): number | null {
  switch (kind) {
    case "rate_limited":
      if (retryAfterSeconds !== undefined) {
        return Math.min(retryAfterSeconds * 1000, RATE_LIMIT_MAX_MS);
      }
      return Math.min(60_000 * 2 ** consecutive, RATE_LIMIT_MAX_MS);
    case "captcha":
      return CAPTCHA_PAUSE_MS;
    case "transient":
      return Math.min(5 * MINUTE * 2 ** Math.max(0, consecutive - 1), POLL_MID_MS);
    case "sign_in_rejected":
    case "invalid_config":
      return null;
  }
}

/** Stable 0–6 minute offset from a string, so every install and source polls at its own minute. */
export function staggerMinutes(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash % 7;
}
