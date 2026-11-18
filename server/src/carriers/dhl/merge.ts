import { type ParcelSnapshot, type SnapshotEvent, epoch } from "../../plugin/api.js";

export interface Answer {
  readonly backend: string;
  readonly parcel: ParcelSnapshot;
}

function freshness(parcel: ParcelSnapshot): number {
  return Math.max(epoch(parcel.deliveredAt), ...parcel.history.map((e) => epoch(e.at)));
}

/**
 * Combines several back ends' view of one code. The answer with the newest scan decides status
 * and dates (the earlier back end wins a tie); details one lacks are filled from the others,
 * and the histories are joined without duplicates. `raw` keeps every answer by back end.
 */
export function mergeAnswers(answers: readonly Answer[]): ParcelSnapshot | null {
  let primary: ParcelSnapshot | undefined;
  for (const { parcel } of answers) {
    if (primary === undefined || freshness(parcel) > freshness(primary)) {
      primary = parcel;
    }
  }
  if (primary === undefined) {
    return null;
  }
  const parcels = answers.map((a) => a.parcel);
  const seen = new Set<string>();
  const history: SnapshotEvent[] = [];
  for (const event of parcels.flatMap((p) => p.history)) {
    const key = `${event.at}\u0000${event.rawStatus}`;
    if (!seen.has(key)) {
      seen.add(key);
      history.push(event);
    }
  }
  history.sort((a, b) => epoch(a.at) - epoch(b.at));
  const base = primary;
  const fill = <K extends "sender" | "receiver" | "weightKg">(key: K): ParcelSnapshot[K] =>
    base[key] ?? parcels.find((p) => p[key] !== null)?.[key] ?? null;
  return {
    ...base,
    sender: fill("sender"),
    receiver: fill("receiver"),
    weightKg: fill("weightKg"),
    history,
    raw: Object.fromEntries(answers.map((a) => [a.backend, a.parcel.raw])),
  };
}
