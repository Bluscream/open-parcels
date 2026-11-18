import type { FetchResult, ParcelSnapshot, PluginContext } from "../../plugin/api.js";
import type { Json } from "../_kit/json.js";
import { fetchGateway, normalizeGateway } from "./gateway.js";
import { fetchIberia, iberiaShaped, normalizeIberia } from "./iberia.js";
import { mergeAnswers, type Answer } from "./merge.js";
import { fetchSweden, normalizeSweden } from "./sweden.js";
import { fetchUnified, normalizeUnified } from "./unified.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

/** Regional back ends asked in addition to the gateway; off unless the source turns them on. */
export interface Regional {
  /** DHL eCommerce Iberia (Spain and Portugal): one request per code. */
  readonly iberia: boolean;
  /** DHL Freight Sweden: one request for every ten-character code. */
  readonly sweden: boolean;
}

export const NO_REGIONAL: Regional = { iberia: false, sweden: false };

/** Pasted codes are trimmed and upper-cased: the gateway is case-sensitive. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

/**
 * Looks codes up on every back end that can answer them: the keyless gateway in one batch, the
 * regional back ends the source turned on, then DHL's official API when the user gave a key. A
 * failing back end fails the run (it is retried with backoff), so a missing code always means
 * "not found", never "not asked".
 */
export async function trackCodes(
  deps: Deps,
  apiKey: string | null,
  barcodes: readonly string[],
  regional: Regional = NO_REGIONAL,
): Promise<FetchResult> {
  const codes = barcodes.map((code) => ({ code, key: normalizeCode(code) }));
  const keys = codes.map((c) => c.key);
  const gateway = await fetchGateway(deps, keys);
  const sweden = regional.sweden ? await fetchSweden(deps, keys) : new Map<string, Json>();
  const snapshots: ParcelSnapshot[] = [];
  for (const { code, key } of codes) {
    const answers: Answer[] = [];
    const fromGateway = gateway.get(key);
    if (fromGateway !== undefined) {
      answers.push({ backend: "gateway", parcel: normalizeGateway(deps, code, fromGateway) });
    }
    const fromSweden = sweden.get(key);
    if (fromSweden !== undefined) {
      answers.push({ backend: "sweden", parcel: normalizeSweden(deps, code, fromSweden) });
    }
    if (regional.iberia && iberiaShaped(key)) {
      const fromIberia = await fetchIberia(deps, key);
      if (fromIberia !== null) {
        answers.push({ backend: "iberia", parcel: normalizeIberia(deps, code, fromIberia) });
      }
    }
    if (apiKey !== null) {
      const shipment = await fetchUnified(deps, apiKey, key);
      if (shipment !== null) {
        answers.push({ backend: "unified", parcel: normalizeUnified(deps, code, shipment) });
      }
    }
    const merged = mergeAnswers(answers);
    if (merged !== null) {
      snapshots.push(merged);
    }
  }
  return { snapshots, complete: true };
}
