import {
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type PluginContext,
  objects,
  parseJsonBody,
} from "../../../plugin/api.js";
import { DE_COOKIE_NAME, DE_TRACKING_HEADERS, DE_TRACKING_URL } from "../constants.js";
import { asObject, asString, type Json } from "../util.js";
import type { DeSession } from "./session.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http">;

async function requestOnce(deps: Deps, idToken: string, pieceCode: string | null) {
  const url = new URL(DE_TRACKING_URL);
  if (pieceCode !== null) {
    url.searchParams.set("piececode", pieceCode);
  }
  url.searchParams.set("noRedirect", "true");
  url.searchParams.set("language", "de");
  url.searchParams.set("cid", "app");
  // The ID token goes to www.dhl.de only; redirects are not followed so it never leaves.
  return deps.http.request(url, {
    headers: { ...DE_TRACKING_HEADERS, cookie: `${DE_COOKIE_NAME}=${idToken}` },
    redirect: "manual",
  });
}

/**
 * The account's shipment list (or one shipment by number). A 401 renews the ID token once and
 * retries once; a second 401 means the sign-in is gone. Network errors stay transient.
 */
export async function fetchEnvelope(
  deps: Deps,
  session: DeSession,
  pieceCode: string | null = null,
): Promise<Json[]> {
  let response = await requestOnce(deps, await session.idToken(), pieceCode);
  if (response.status === 401) {
    response = await requestOnce(deps, await session.refresh(), pieceCode);
    if (response.status === 401) {
      throw new SignInRejectedError("DHL refused the renewed session.");
    }
  }
  if (response.status !== 200) {
    throw new TransientError(`DHL's tracking endpoint answered HTTP ${response.status}.`);
  }
  const body = asObject(parseJsonBody(response.body));
  if (body === null) {
    // Most likely a consent or challenge page; stop instead of guessing.
    throw new UnexpectedResponseError("DHL's tracking endpoint did not answer with JSON.");
  }
  if (body["rateLimited"] === true) {
    throw new RateLimitedError("DHL's tracking endpoint reported a rate limit.", undefined);
  }
  if (!Array.isArray(body["sendungen"])) {
    throw new UnexpectedResponseError("DHL's tracking answer has no shipment list.");
  }
  return objects(body["sendungen"]);
}

const ARCHIVED = "ARCHIVIERT";

/**
 * Drops archived entries, always. Keeping them only when nothing else is left made a parcel flip
 * between gone and present as other parcels came and went.
 */
export function activeElements(elements: readonly Json[]): Json[] {
  return elements.filter(
    (e) => asString(asObject(e["sendungsinfo"])?.["sendungsliste"])?.toUpperCase() !== ARCHIVED,
  );
}

/** A bare inbox entry that only a lookup by number fills in. */
export function needsEnrichment(element: Json): boolean {
  if (asObject(element["sendungNichtGefunden"]) !== null) {
    return false;
  }
  const details = asObject(element["sendungsdetails"]);
  if (details === null || asObject(details["sendungNichtGefunden"]) !== null) {
    return false;
  }
  return asObject(details["sendungsverlauf"]) === null;
}

/** An entry that is not a real parcel: marked as unknown, or without any progress at all. */
export function isNotFound(element: Json): boolean {
  if (asObject(element["sendungNichtGefunden"])?.["keineDatenVerfuegbar"] === true) {
    return true;
  }
  const verlauf = asObject(asObject(element["sendungsdetails"])?.["sendungsverlauf"]);
  if (verlauf === null) {
    return true;
  }
  const events = Array.isArray(verlauf["events"]) ? verlauf["events"] : [];
  return events.length === 0 && asString(verlauf["kurzStatus"]) === null;
}
