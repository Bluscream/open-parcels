import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiUrl } from "./fetcher";
import { keys } from "./queries";

const PARCEL_EVENTS = [
  "parcel.registered",
  "parcel.status_changed",
  "parcel.delivered",
  "parcel.delivery_time_changed",
  "parcel.outgoing_registered",
  "parcel.outgoing_delivered",
  "parcel.live_updated",
  "parcel.removed",
  "parcel.deleted",
] as const;

/** Source events: a state change, a finished run (new run times and counts), a removal. */
const SOURCE_EVENTS = ["source.state_changed", "source.run_finished", "source.removed"] as const;

export type LiveState = "connecting" | "live" | "offline";

/** Live position updates arrive every 30 s per parcel; the lists follow them at most this often. */
export const LIVE_LIST_REFRESH_MS = 60_000;

/**
 * Runs `refresh` at once when it has not run for `intervalMs`, otherwise once at the end of that
 * window, so a burst of requests costs at most one run per window and the last one is never lost.
 */
export function throttled(
  refresh: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): { request: () => void; cancel: () => void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    pending = undefined;
    last = now();
    refresh();
  };
  return {
    request: () => {
      const wait = last + intervalMs - now();
      if (wait <= 0) {
        run();
      } else {
        pending ??= setTimeout(run, wait);
      }
    },
    cancel: () => {
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
    },
  };
}

interface EventPayload {
  readonly id?: unknown;
  readonly parcel?: { readonly id?: unknown };
}

function parcelIdOf(data: string): string | undefined {
  try {
    const payload = JSON.parse(data) as EventPayload;
    const id = payload.parcel?.id ?? payload.id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribes to the server's event stream and refreshes the affected queries. EventSource
 * reconnects by itself and sends `Last-Event-ID`, so nothing is missed across short drops.
 */
export function useLiveUpdates(enabled: boolean): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      return undefined;
    }
    const source = new EventSource(apiUrl("/api/v1/events"), { withCredentials: true });
    const refreshLists = (): void => {
      void client.invalidateQueries({ queryKey: keys.parcels });
      void client.invalidateQueries({ queryKey: ["calendar"] });
    };
    // A live update changes one parcel's courier position, not what the lists show.
    const liveLists = throttled(refreshLists, LIVE_LIST_REFRESH_MS);
    const onParcel = (event: MessageEvent<string>): void => {
      if (event.type === "parcel.live_updated") {
        liveLists.request();
      } else {
        refreshLists();
      }
      const id = parcelIdOf(event.data);
      if (id !== undefined && event.type === "parcel.deleted") {
        client.removeQueries({ queryKey: keys.parcel(id) });
      } else if (id !== undefined) {
        void client.invalidateQueries({ queryKey: keys.parcel(id) });
      }
    };
    const onSource = (): void => {
      void client.invalidateQueries({ queryKey: keys.sources });
      // A run may have changed parcels without a parcel event (lookup state, last seen), and a
      // removed source takes its links with it.
      void client.invalidateQueries({ queryKey: keys.parcels });
    };
    source.onopen = () => {
      setState("live");
    };
    source.onerror = () => {
      setState(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    };
    for (const type of PARCEL_EVENTS) {
      source.addEventListener(type, onParcel);
    }
    for (const type of SOURCE_EVENTS) {
      source.addEventListener(type, onSource);
    }
    // The server could not replay what was missed (too old, or a reset database): reload all.
    const onResync = (): void => {
      void client.invalidateQueries();
    };
    source.addEventListener("resync", onResync);
    return () => {
      liveLists.cancel();
      source.close();
    };
  }, [client, enabled]);

  return state;
}
