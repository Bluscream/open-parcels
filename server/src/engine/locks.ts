/**
 * One holder at a time per key. Used per source, so a run, a live read and each sign-in step of
 * one account never talk to the carrier at the same time; single-use refresh tokens would
 * otherwise race. Not re-entrant: a holder must never ask for its own key again.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }

  /** Whether anyone holds or waits for the key; for tests and diagnostics. */
  busy(key: string): boolean {
    return this.#tails.has(key);
  }
}
