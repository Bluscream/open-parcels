import type { Clock } from "../clock.js";

/** Limits failed sign-in attempts per client address to slow down password guessing. */
export class LoginThrottle {
  readonly #failures = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  #recent(key: string): number[] {
    const cutoff = this.clock.now().getTime() - this.windowMs;
    const recent = (this.#failures.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) {
      this.#failures.delete(key);
    } else {
      this.#failures.set(key, recent);
    }
    return recent;
  }

  /** Seconds until another attempt is allowed, or 0 when allowed now. */
  retryAfterSeconds(key: string): number {
    const recent = this.#recent(key);
    if (recent.length < this.maxFailures) {
      return 0;
    }
    const oldest = recent[0] ?? this.clock.now().getTime();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.clock.now().getTime()) / 1000));
  }

  recordFailure(key: string): void {
    this.#failures.set(key, [...this.#recent(key), this.clock.now().getTime()]);
  }

  reset(key: string): void {
    this.#failures.delete(key);
  }
}
