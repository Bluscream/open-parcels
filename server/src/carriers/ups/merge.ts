import { epoch, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";

export interface Answer {
  readonly backend: "public" | "official";
  readonly parcel: ParcelSnapshot;
}

function freshness(parcel: ParcelSnapshot): number {
  return Math.max(epoch(parcel.deliveredAt), ...parcel.history.map((e) => epoch(e.at)));
}

/**
 * Combines both back ends' view of one code. The answer with the newest scan decides status and
 * dates (the earlier answer wins a tie); a delivery window or weight one lacks is taken from the
 * other, and the histories are joined without duplicates. `raw` keeps each answer by back end.
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
  const fill = <K extends "weightKg" | "plannedFrom" | "plannedTo">(key: K): ParcelSnapshot[K] =>
    base[key] ?? parcels.find((p) => p[key] !== null)?.[key] ?? null;
  const windowed = base.delivered
    ? { plannedFrom: null, plannedTo: null }
    : {
        plannedFrom: fill("plannedFrom"),
        plannedTo: fill("plannedTo"),
      };
  return {
    ...base,
    ...windowed,
    weightKg: fill("weightKg"),
    history,
    raw: Object.fromEntries(answers.map((a) => [a.backend, a.parcel.raw])),
  };
}
