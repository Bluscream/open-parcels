import { describe, expect, it } from "vitest";
import {
  delayAfterFailure,
  nextRunAfterSuccess,
  POLL_HOT_MS,
  POLL_IDLE_MS,
  POLL_MID_MS,
  staggerMinutes,
  type PollContext,
} from "../../src/engine/policy.js";
import { localParts, nextLocalMidnight, zonedTime } from "../../src/engine/tz.js";

const TZ = "Europe/Berlin";

function context(now: string, overrides: Partial<PollContext> = {}): PollContext {
  return {
    now: new Date(now),
    timeZone: TZ,
    kind: "account",
    staggerMinutes: 0,
    active: [],
    ...overrides,
  };
}

describe("time-zone helpers", () => {
  it("converts local wall-clock times in winter and summer", () => {
    expect(zonedTime({ year: 2026, month: 1, day: 10, hour: 6, minute: 0 }, TZ).toISOString()).toBe(
      "2026-01-10T05:00:00.000Z",
    );
    expect(zonedTime({ year: 2026, month: 7, day: 10, hour: 6, minute: 0 }, TZ).toISOString()).toBe(
      "2026-07-10T04:00:00.000Z",
    );
  });

  it("finds the next local midnight across the October change", () => {
    // 2026-10-25 is the last Sunday of October: clocks go back at 03:00 local.
    expect(nextLocalMidnight(new Date("2026-10-24T20:00:00Z"), TZ).toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    expect(nextLocalMidnight(new Date("2026-10-25T20:00:00Z"), TZ).toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
  });

  it("skips the March gap to the first valid instant", () => {
    // 2026-03-29 02:30 does not exist in Berlin.
    const result = zonedTime({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, TZ);
    expect(localParts(result, TZ).hour).toBe(3);
  });
});

describe("poll scheduling", () => {
  it("uses the mid tier for parcels in flight", () => {
    const next = nextRunAfterSuccess(
      context("2026-11-18T10:00:00Z", { active: [{ status: "in_transit", plannedFrom: null }] }),
    );
    expect(next?.getTime()).toBe(new Date("2026-11-18T10:00:00Z").getTime() + POLL_MID_MS);
  });

  it("uses the hot tier for a parcel out for delivery without a window", () => {
    const next = nextRunAfterSuccess(
      context("2026-11-18T10:00:00Z", {
        active: [{ status: "out_for_delivery", plannedFrom: null }],
      }),
    );
    expect(next?.getTime()).toBe(new Date("2026-11-18T10:00:00Z").getTime() + POLL_HOT_MS);
  });

  it("waits with the hot tier until an hour before the window opens", () => {
    const early = context("2026-11-18T09:00:00Z", {
      active: [{ status: "out_for_delivery", plannedFrom: "2026-11-18T16:00:00Z" }],
    });
    expect(nextRunAfterSuccess(early)?.getTime()).toBe(
      new Date("2026-11-18T09:00:00Z").getTime() + POLL_MID_MS,
    );
    const close = context("2026-11-18T15:10:00Z", {
      active: [{ status: "out_for_delivery", plannedFrom: "2026-11-18T16:00:00Z" }],
    });
    expect(nextRunAfterSuccess(close)?.getTime()).toBe(
      new Date("2026-11-18T15:10:00Z").getTime() + POLL_HOT_MS,
    );
  });

  it("keeps idle accounts polling slowly and stops idle tracking sources", () => {
    expect(nextRunAfterSuccess(context("2026-11-18T10:00:00Z"))?.getTime()).toBe(
      new Date("2026-11-18T10:00:00Z").getTime() + POLL_IDLE_MS,
    );
    expect(nextRunAfterSuccess(context("2026-11-18T10:00:00Z", { kind: "tracking" }))).toBeNull();
  });

  it("adds the stagger", () => {
    const next = nextRunAfterSuccess(
      context("2026-11-18T10:00:00Z", {
        staggerMinutes: 4,
        active: [{ status: "in_transit", plannedFrom: null }],
      }),
    );
    expect(next?.getTime()).toBe(
      new Date("2026-11-18T10:00:00Z").getTime() + POLL_MID_MS + 4 * 60_000,
    );
  });

  it("moves runs that land in the night to a midnight catch-up, then to 06:00", () => {
    // 23:30 Berlin (22:30Z) + 45 min = 00:15 local: catch up at midnight instead.
    const late = nextRunAfterSuccess(
      context("2026-11-18T22:30:00Z", { active: [{ status: "in_transit", plannedFrom: null }] }),
    );
    expect(late?.toISOString()).toBe("2026-11-18T23:00:00.000Z");
    // At midnight the next run goes to 06:00 local.
    const night = nextRunAfterSuccess(
      context("2026-11-18T23:00:00Z", { active: [{ status: "in_transit", plannedFrom: null }] }),
    );
    expect(night?.toISOString()).toBe("2026-11-19T05:00:00.000Z");
  });

  it("gives every seed a stable stagger between 0 and 6 minutes", () => {
    expect(staggerMinutes("install-a:source-1")).toBe(staggerMinutes("install-a:source-1"));
    for (const seed of ["a", "b", "c", "install:source", "x".repeat(100)]) {
      expect(staggerMinutes(seed)).toBeGreaterThanOrEqual(0);
      expect(staggerMinutes(seed)).toBeLessThanOrEqual(6);
    }
  });
});

describe("failure backoff", () => {
  it("honours Retry-After, capped at one hour", () => {
    expect(delayAfterFailure("rate_limited", 1, 120)).toBe(120_000);
    expect(delayAfterFailure("rate_limited", 1, 99_999)).toBe(3_600_000);
  });

  it("doubles without Retry-After: 120 s for the first 429", () => {
    expect(delayAfterFailure("rate_limited", 1)).toBe(120_000);
    expect(delayAfterFailure("rate_limited", 2)).toBe(240_000);
    expect(delayAfterFailure("rate_limited", 10)).toBe(3_600_000);
  });

  it("retries transient errors from 5 minutes up to the mid tier", () => {
    expect(delayAfterFailure("transient", 1)).toBe(300_000);
    expect(delayAfterFailure("transient", 2)).toBe(600_000);
    expect(delayAfterFailure("transient", 9)).toBe(POLL_MID_MS);
  });

  it("pauses six hours on a captcha and stops on rejected sign-ins", () => {
    expect(delayAfterFailure("captcha", 1)).toBe(6 * 3_600_000);
    expect(delayAfterFailure("sign_in_rejected", 1)).toBeNull();
  });
});
