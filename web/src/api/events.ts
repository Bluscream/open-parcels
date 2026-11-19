import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiUrl } from "./fetcher";
import { settingsKey } from "../settings/home";
import { keys } from "./queries";

const PARCEL_EVENTS = [
  "parcel.registered",
  "parcel.status_changed",
  "parcel.delivered",
  "parcel.delivery_time_changed",
  "parcel.outgoing_registered",
  "parcel.outgoing_delivered",
  "parcel.live_updated",
  "parcel.location_changed",
  "parcel.removed",
  "parcel.deleted",
] as const;

/** Source events: added, renamed, a state change, a finished run (run times, counts), a removal. */
const SOURCE_EVENTS = [
  "source.added",
  "source.updated",
  "source.state_changed",
  "source.run_finished",
  "source.removed",
] as const;

/** An order renamed, (un)archived by hand, or deleted. */
const ORDER_EVENTS = ["order.updated", "order.deleted"] as const;

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

function subjectIdOf(data: string): string | undefined {
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
      // An order's status and archiving follow its parcels.
      void client.invalidateQueries({ queryKey: keys.orders });
    };
    // A live update changes one parcel's courier position, not what the lists show.
    const liveLists = throttled(refreshLists, LIVE_LIST_REFRESH_MS);
    const onParcel = (event: MessageEvent<string>): void => {
      if (event.type === "parcel.live_updated") {
        liveLists.request();
      } else {
        refreshLists();
      }
      const id = subjectIdOf(event.data);
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
    // A changed setting (home, how parcels are named) changes every parcel's view.
    source.addEventListener("settings.updated", () => {
      void client.invalidateQueries({ queryKey: settingsKey });
      void client.invalidateQueries({ queryKey: keys.parcels });
    });
    const onOrder = (event: MessageEvent<string>): void => {
      const id = subjectIdOf(event.data);
      if (id !== undefined && event.type === "order.deleted") {
        client.removeQueries({ queryKey: keys.order(id) });
      }
      // Orders and the parcels that name them.
      void client.invalidateQueries({ queryKey: keys.orders });
      void client.invalidateQueries({ queryKey: keys.parcels });
    };
    for (const type of ORDER_EVENTS) {
      source.addEventListener(type, onOrder);
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
