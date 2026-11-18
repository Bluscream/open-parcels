import type { Direction, ParcelStatus } from "../domain/parcel.js";
import type { EventType } from "../events/types.js";

/** What the event rules compare. `status` is the effective status: a manual override wins. */
export interface EventView {
  readonly direction: Direction;
  readonly status: ParcelStatus;
  readonly delivered: boolean;
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
}

export interface DerivedEvent {
  readonly type: EventType;
  readonly changes: Readonly<Record<string, unknown>>;
}

/**
 * The canonical event rules:
 * - a new, undelivered parcel fires `registered` (or `outgoing_registered`); a parcel first seen
 *   already delivered is history and fires nothing, so an account's first sync never floods
 *   notifications;
 * - the hop to delivered fires only `delivered` (or `outgoing_delivered`), never also
 *   `status_changed`;
 * - other status changes fire `status_changed`;
 * - a changed delivery window on an undelivered parcel fires `delivery_time_changed`.
 */
export function deriveEvents(before: EventView | null, after: EventView): DerivedEvent[] {
  if (before === null) {
    if (after.delivered || after.status === "delivered") {
      return [];
    }
    return [
      {
        type: after.direction === "outgoing" ? "parcel.outgoing_registered" : "parcel.registered",
        changes: {},
      },
    ];
  }
  const events: DerivedEvent[] = [];
  if (before.status !== after.status) {
    const changes = { old_status: before.status, new_status: after.status };
    if (after.status === "delivered") {
      events.push({
        type: after.direction === "outgoing" ? "parcel.outgoing_delivered" : "parcel.delivered",
        changes,
      });
    } else {
      events.push({ type: "parcel.status_changed", changes });
    }
  }
  const windowChanged =
    before.plannedFrom !== after.plannedFrom || before.plannedTo !== after.plannedTo;
  if (windowChanged && !after.delivered && after.status !== "delivered") {
    events.push({
      type: "parcel.delivery_time_changed",
      changes: {
        old_planned_from: before.plannedFrom,
        old_planned_to: before.plannedTo,
        new_planned_from: after.plannedFrom,
        new_planned_to: after.plannedTo,
      },
    });
  }
  return events;
}
