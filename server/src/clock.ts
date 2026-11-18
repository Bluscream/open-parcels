/** Injected time source, so scheduling and expiry logic can be tested with a fake clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
