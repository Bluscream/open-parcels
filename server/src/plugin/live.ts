import type { LiveState } from "../domain/parcel.js";

/**
 * Attached to a snapshot when the carrier can show the courier for this parcel. `ref` is opaque
 * to the engine (for example a tracking id plus whatever the carrier's map endpoint needs) and is
 * kept in memory only, never stored with the parcel.
 */
export interface LiveTarget {
  readonly ref: unknown;
  /** The carrier's page already shows a map, so a session is likely open right now. */
  readonly mapShown: boolean;
}

/** One reading of the courier's map. Coordinates are the courier's, never the destination's. */
export interface LiveReading {
  readonly state: LiveState;
  readonly stopsAway: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accuracy: number | null;
  /** When the courier was at that position. */
  readonly positionAt: string | null;
  /** The carrier's own text, e.g. "4 stops away", in the account's language. */
  readonly message: string | null;
}
