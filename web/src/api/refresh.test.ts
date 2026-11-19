import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttled } from "./events";
import { invalidateParcelViews } from "./queries";

describe("refreshing after a parcel edit", () => {
  it("refreshes the calendar and the orders too, not only the lists", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidateParcelViews(client);
    // Orders follow their parcels' status and archiving.
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["parcels"],
      ["calendar"],
      ["orders"],
    ]);
  });
});

describe("list refreshes for live updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("run at most once a window, and the last request is never lost", () => {
    const refresh = vi.fn();
    const lists = throttled(refresh, 60_000);
    lists.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Ten parcels' live updates within the window: one refresh at its end, not ten.
    for (let step = 0; step < 10; step += 1) {
      vi.advanceTimersByTime(5_000);
      lists.request();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing more once cancelled", () => {
    const refresh = vi.fn();
    const lists = throttled(refresh, 60_000);
    lists.request();
    lists.request();
    lists.cancel();
    vi.advanceTimersByTime(120_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
