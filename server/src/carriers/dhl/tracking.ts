import type { FetchResult, ParcelSnapshot, PluginContext } from "../../plugin/api.js";
import { fetchGateway, normalizeGateway } from "./gateway.js";
import { mergeAnswers, type Answer } from "./merge.js";
import { fetchUnified, normalizeUnified } from "./unified.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "reportUnknown">;

/** Pasted codes are trimmed and upper-cased: the gateway is case-sensitive. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

/**
 * Looks codes up on every back end that can answer them: the keyless gateway in one batch,
 * then DHL's official API when the user gave a key. A failing back end fails the run (it is
 * retried with backoff), so a missing code always means "not found", never "not asked".
 */
export async function trackCodes(
  deps: Deps,
  apiKey: string | null,
  barcodes: readonly string[],
): Promise<FetchResult> {
  const codes = barcodes.map((code) => ({ code, key: normalizeCode(code) }));
  const gateway = await fetchGateway(
    deps,
    codes.map((c) => c.key),
  );
  const snapshots: ParcelSnapshot[] = [];
  for (const { code, key } of codes) {
    const answers: Answer[] = [];
    const fromGateway = gateway.get(key);
    if (fromGateway !== undefined) {
      answers.push({ backend: "gateway", parcel: normalizeGateway(deps, code, fromGateway) });
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
