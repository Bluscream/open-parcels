import type { FetchResult, PluginLogger } from "../plugin/api.js";
import type { ParcelSnapshot } from "../plugin/snapshot.js";

/** The warning logged when a plug-in files an answer under anything but a tracked code. */
export const NOT_FILED_AS_TRACKED = "A lookup answer was not filed under the tracked code.";

/** A code's comparable form: upper case, without spaces, dashes or dots. */
function canonical(code: string): string {
  return code.toUpperCase().replace(/[\s.-]/gu, "");
}

function refiled(found: ParcelSnapshot, tracked: string): ParcelSnapshot {
  return { ...found, barcode: tracked, externalRef: found.externalRef ?? found.barcode };
}

/**
 * Files every answer of a lookup under the code that was asked for. A plug-in should do this
 * itself (`trackEach` does); this is the host's safety net, so a carrier echoing its own number
 * can never make the tracked code read as not found and add a second parcel. An answer that
 * matches no asked code is filed under the only code when one was asked, and dropped otherwise.
 * Every correction is logged, so a plug-in that relies on it shows up in its tests.
 */
export function fileUnderTracked(
  pluginId: string,
  barcodes: readonly string[],
  result: FetchResult,
  logger: PluginLogger,
): FetchResult {
  const asked = new Set(barcodes);
  const byCanonical = new Map(barcodes.map((code) => [canonical(code), code]));
  const only = asked.size === 1 ? barcodes[0] : undefined;
  const snapshots: ParcelSnapshot[] = [];
  for (const found of result.snapshots) {
    if (found.handoff !== null || asked.has(found.barcode)) {
      snapshots.push(found);
      continue;
    }
    const tracked =
      byCanonical.get(canonical(found.barcode)) ??
      (found.externalRef !== null ? byCanonical.get(canonical(found.externalRef)) : undefined) ??
      only;
    logger.warn({ plugin: pluginId, filedAs: tracked ?? null }, NOT_FILED_AS_TRACKED);
    if (tracked !== undefined) {
      snapshots.push(refiled(found, tracked));
    }
  }
  return { ...result, snapshots };
}
