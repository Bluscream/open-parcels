import type { FetchResult, ParcelSnapshot, PluginContext } from "../../../plugin/api.js";
import { DE_ENRICH_LIMIT } from "../constants.js";
import { asString, type Json } from "../util.js";
import { activeElements, fetchEnvelope, isNotFound, needsEnrichment } from "./inbox.js";
import { normalizeDe } from "./normalize.js";
import { DeSession } from "./session.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session" | "reportUnknown">;

/**
 * Everything the German DHL account lists. Bare entries are looked up by number, a few per run;
 * the rest wait for the next run, so the list stays complete without a burst of requests.
 */
export async function fetchDeAccount(deps: Deps, refreshToken: string): Promise<FetchResult> {
  const session = new DeSession(deps, refreshToken);
  const elements = activeElements(await fetchEnvelope(deps, session));
  const snapshots: ParcelSnapshot[] = [];
  let lookups = 0;
  for (let element of elements) {
    const id = asString(element["id"]);
    if (id !== null && needsEnrichment(element) && lookups < DE_ENRICH_LIMIT) {
      lookups += 1;
      const detailed: Json | undefined = (await fetchEnvelope(deps, session, id)).find(
        (e) => asString(e["id"]) === id,
      );
      element = detailed ?? element;
    }
    if (needsEnrichment(element) || !isNotFound(element)) {
      const parcel = normalizeDe(deps, element);
      if (parcel !== null) {
        snapshots.push(parcel);
      }
    }
  }
  return { snapshots, complete: true };
}
