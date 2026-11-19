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
    const onParcel = (event: MessageEvent<string>): void => {
      void client.invalidateQueries({ queryKey: keys.parcels });
      void client.invalidateQueries({ queryKey: ["calendar"] });
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
    return () => {
      source.close();
    };
  }, [client, enabled]);

  return state;
}
