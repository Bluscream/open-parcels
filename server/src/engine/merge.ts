import type { Direction, ParcelStatus } from "../domain/parcel.js";
import type { ParcelSnapshot, SnapshotEvent } from "../plugin/snapshot.js";

/** The parcel fields a snapshot can change. */
export interface ParcelState {
  readonly direction: Direction;
  readonly status: ParcelStatus;
  readonly rawStatus: string | null;
  readonly statusAt: string | null;
  readonly delivered: boolean;
  readonly deliveredAt: string | null;
  readonly plannedFrom: string | null;
  readonly plannedTo: string | null;
  readonly pickup: boolean;
  readonly pickupPoint: string | null;
  readonly url: string | null;
  readonly sender: string | null;
  readonly receiver: string | null;
  readonly weightKg: number | null;
}

/**
 * `carrier`: the company carrying the parcel reports on its own parcel.
 * `secondary`: someone else's view of it, e.g. the shop after a hand-off, or a mail.
 */
export type Authority = "carrier" | "secondary";

export interface ResolvedStatus {
  readonly status: ParcelStatus;
  /** Raw value that did not map, so the caller can warn once; null when the latest value mapped. */
  readonly unmapped: string | null;
}

function newest(events: readonly SnapshotEvent[]): SnapshotEvent | undefined {
  let best: SnapshotEvent | undefined;
  for (const event of events) {
    if (best === undefined || event.at > best.at) {
      best = event;
    }
  }
  return best;
}

/**
 * The suite's rule for unknown statuses: use the mapped latest value; otherwise the newest
 * history entry that maps; only then `unknown`.
 */
export function resolveSnapshotStatus(snapshot: ParcelSnapshot): ResolvedStatus {
  if (snapshot.status !== null) {
    return { status: snapshot.status, unmapped: null };
  }
  const mapped = snapshot.history.filter((event) => event.status !== null);
  const fallback = newest(mapped)?.status ?? null;
  return { status: fallback ?? "unknown", unmapped: snapshot.rawStatus };
}

export function newestEventAt(snapshot: ParcelSnapshot): string | null {
  return newest(snapshot.history)?.at ?? null;
}

/** May this snapshot set the status, given what is stored? Newer scans win; the carrier wins ties. */
function maySetStatus(
  current: ParcelState | null,
  authority: Authority,
  snapshotAt: string | null,
): boolean {
  if (current === null) {
    return true;
  }
  if (snapshotAt !== null && current.statusAt !== null) {
    return authority === "carrier" ? snapshotAt >= current.statusAt : snapshotAt > current.statusAt;
  }
  return authority === "carrier";
}

/** Merges one snapshot into the stored state. Pure: no I/O, no clock. */
export function mergeParcel(
  current: ParcelState | null,
  snapshot: ParcelSnapshot,
  authority: Authority,
): ParcelState {
  const snapshotAt = newestEventAt(snapshot);
  const setStatus = maySetStatus(current, authority, snapshotAt);
  const resolved = resolveSnapshotStatus(snapshot);
  const prefer = <T>(fromSnapshot: T | null, stored: T | null | undefined): T | null =>
    authority === "carrier" ? (fromSnapshot ?? stored ?? null) : (stored ?? fromSnapshot ?? null);

  const status = setStatus ? resolved.status : (current?.status ?? resolved.status);
  const delivered = setStatus
    ? snapshot.delivered || resolved.status === "delivered"
    : (current?.delivered ?? false);
  const windowFromSnapshot = snapshot.plannedFrom !== null && setStatus;
  return {
    direction: current?.direction ?? snapshot.direction,
    status,
    rawStatus: setStatus ? snapshot.rawStatus : (current?.rawStatus ?? snapshot.rawStatus),
    statusAt: setStatus ? (snapshotAt ?? current?.statusAt ?? null) : (current?.statusAt ?? null),
    delivered,
    deliveredAt: delivered ? (snapshot.deliveredAt ?? current?.deliveredAt ?? snapshotAt) : null,
    // A delivered parcel has no plan any more.
    plannedFrom: delivered
      ? null
      : windowFromSnapshot
        ? snapshot.plannedFrom
        : (current?.plannedFrom ?? snapshot.plannedFrom),
    plannedTo: delivered
      ? null
      : windowFromSnapshot
        ? snapshot.plannedTo
        : (current?.plannedTo ?? snapshot.plannedTo),
    pickup: setStatus
      ? snapshot.pickup || (current?.pickup ?? false)
      : (current?.pickup ?? snapshot.pickup),
    pickupPoint: prefer(snapshot.pickupPoint, current?.pickupPoint),
    url: prefer(snapshot.url, current?.url),
    sender: prefer(snapshot.sender, current?.sender),
    receiver: prefer(snapshot.receiver, current?.receiver),
    weightKg: prefer(snapshot.weightKg, current?.weightKg),
  };
}
