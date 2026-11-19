import { isStopPrecise, type Place } from "./geocoder.js";

export interface Point {
  readonly latitude: number;
  readonly longitude: number;
}

/** One place a name may stand for, in the search's order (most relevant first). */
export interface Candidate extends Point {
  readonly label: string;
  /** Nominatim's `importance` (0–1), null when the service did not say. */
  readonly importance: number | null;
}

/** Answers this close to an earlier one are the same place (a town and its municipality). */
export const SAME_PLACE_KM = 25;
/**
 * A stop between two known ones is implausible when it lengthens the way by more than this and
 * by more than `DETOUR_FACTOR` times the direct way: 3,400 km off a 100 km leg is another place
 * of that name, while a hub 300 km to the side, or any stop on a long-haul leg, is not.
 */
export const MAX_DETOUR_KM = 1_000;
export const DETOUR_FACTOR = 2;
/** Without any context the first answer counts only when it leads every other by this much. */
export const PROMINENCE_GAP = 0.1;

const EARTH_RADIUS_KM = 6_371;

/** Great-circle distance (haversine). */
export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The places a name may stand for, from a search's answers: every answer precise enough for a
 * stop, without repeats of the same spot. None when the first answer is a country or region:
 * the name then means that region, and towns of the same name further down are other places.
 */
export function usableCandidates(found: readonly Place[]): Candidate[] {
  const first = found[0];
  if (first === undefined || !isStopPrecise(first)) return [];
  const kept: Candidate[] = [];
  for (const place of found) {
    if (!isStopPrecise(place)) continue;
    if (kept.some((other) => distanceKm(other, place) < SAME_PLACE_KM)) continue;
    kept.push({
      label: place.label,
      latitude: place.latitude,
      longitude: place.longitude,
      importance: place.importance,
    });
  }
  return kept;
}

/** One scan of a parcel, oldest first. */
export interface RouteScan {
  /** The carrier's own position: never changed, and context for the others. */
  readonly fixed: Point | null;
  /**
   * What the scan's place name may stand for; empty when nothing was found. Null when there is
   * nothing to decide: the scan has a carrier position, no name, or a name not looked up yet.
   */
  readonly candidates: readonly Candidate[] | null;
}

interface Detour {
  readonly km: number;
  readonly implausible: boolean;
}

/** The nearest placed scan from `index` in direction `step` that is not at `point` itself. */
function neighbour(
  placed: readonly (Point | undefined)[],
  index: number,
  step: -1 | 1,
  point: Point,
): Point | undefined {
  for (let i = index + step; i >= 0 && i < placed.length; i += step) {
    const other = placed[i];
    if (other === undefined) continue;
    if (other.latitude !== point.latitude || other.longitude !== point.longitude) return other;
  }
  return undefined;
}

/**
 * How far `point` at scan `index` lies off the way between the nearest placed scans around it.
 * Scans at the very same spot are passed over: several scans in one place stand or fall
 * together, a repeat must not vouch for a wrong place.
 */
function detour(placed: readonly (Point | undefined)[], index: number, point: Point): Detour {
  const before = neighbour(placed, index, -1, point);
  const after = neighbour(placed, index, 1, point);
  if (before !== undefined && after !== undefined) {
    const direct = distanceKm(before, after);
    const km = distanceKm(before, point) + distanceKm(point, after) - direct;
    return { km, implausible: km > MAX_DETOUR_KM && km > DETOUR_FACTOR * direct };
  }
  // One neighbour: the first or last leg of a route may be any length (an import), so the
  // distance ranks the candidates but rejects none.
  const only = before ?? after;
  return { km: only === undefined ? 0 : distanceKm(only, point), implausible: false };
}

/** The first candidate when it clearly leads the others by importance, for names without context. */
function prominent(candidates: readonly Candidate[]): Candidate | undefined {
  const [first, ...others] = candidates;
  const lead = first?.importance ?? null;
  if (lead === null) return undefined;
  return others.every((other) => lead - (other.importance ?? 0) >= PROMINENCE_GAP)
    ? first
    : undefined;
}

/** Takes unambiguous names as given, then drops the worst implausible one until none is left. */
function placeUnambiguous(scans: readonly RouteScan[], placed: (Point | undefined)[]): void {
  const single: number[] = [];
  scans.forEach((scan, index) => {
    if (scan.fixed !== null || scan.candidates?.length !== 1) return;
    placed[index] = scan.candidates[0];
    single.push(index);
  });
  for (;;) {
    let worst: { index: number; km: number } | undefined;
    for (const index of single) {
      const point = placed[index];
      if (point === undefined) continue;
      const { km, implausible } = detour(placed, index, point);
      if (implausible && (worst === undefined || km > worst.km)) worst = { index, km };
    }
    if (worst === undefined) return;
    placed[worst.index] = undefined;
  }
}

/** Places ambiguous names oldest first, each by the smallest plausible detour. */
function placeAmbiguous(scans: readonly RouteScan[], placed: (Point | undefined)[]): void {
  const ambiguous: { index: number; candidates: readonly Candidate[] }[] = [];
  scans.forEach((scan, index) => {
    if (scan.fixed === null && scan.candidates !== null && scan.candidates.length > 1) {
      ambiguous.push({ index, candidates: scan.candidates });
    }
  });
  const hasContext = (): boolean => placed.some((point) => point !== undefined);
  if (!hasContext()) {
    // No context at all: the oldest name with a clearly prominent first answer starts the route.
    const start = ambiguous.find(({ candidates }) => prominent(candidates) !== undefined);
    if (start !== undefined) placed[start.index] = prominent(start.candidates);
  }
  if (!hasContext()) return;
  for (const { index, candidates } of ambiguous) {
    if (placed[index] !== undefined) continue;
    let best: { point: Candidate; km: number } | undefined;
    for (const point of candidates) {
      const { km, implausible } = detour(placed, index, point);
      // Strictly smaller: on a tie the search's own order decides.
      if (!implausible && (best === undefined || km < best.km)) best = { point, km };
    }
    placed[index] = best?.point;
  }
}

/**
 * Chooses, for every scan of one parcel that names a place, which candidate it stands for,
 * using the parcel's other scans as context. Returns one entry per scan: the chosen point, null
 * to leave the scan unplaced, undefined where there was nothing to decide.
 *
 * 1. Carrier positions are fixed context.
 * 2. Names with one candidate are taken as given. Then, while any of them is implausible
 *    between its nearest placed scans before and after (see `MAX_DETOUR_KM`), the one with the
 *    largest detour is dropped and the rest judged again.
 * 3. Names with several candidates follow oldest first, each seeing the choices before it: the
 *    candidate with the smallest detour (before→candidate→after minus before→after; with one
 *    neighbour, the distance to it) wins, implausible ones are out, and with none left the scan
 *    stays unplaced. Should no scan of the parcel be placed by then, the oldest name whose
 *    first candidate is clearly the most prominent (`PROMINENCE_GAP`) starts the route; without
 *    one, the ambiguous names stay unplaced.
 *
 * The same scans always give the same answer, whatever was chosen before.
 */
export function chooseStops(scans: readonly RouteScan[]): (Point | null | undefined)[] {
  const placed: (Point | undefined)[] = scans.map((scan) => scan.fixed ?? undefined);
  placeUnambiguous(scans, placed);
  placeAmbiguous(scans, placed);
  return scans.map((scan, index) =>
    scan.fixed !== null || scan.candidates === null ? undefined : (placed[index] ?? null),
  );
}
