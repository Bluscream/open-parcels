import {
  asObject,
  isObject,
  readObject,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type PluginContext,
} from "../../plugin/api.js";
import type { InPostSession } from "./session.js";
import { INBOX_HOST, text, type Market } from "./shared.js";

type Http = PluginContext<unknown, unknown>["http"];

export const PL_INBOX_URL = `https://${INBOX_HOST}/v3/parcels/tracked`;
export const IT_INBOX_URL = `https://${INBOX_HOST}/global/cps/api/v1/parcels`;
/** A cap on the Italian inbox's cursor pages, so a cursor that never ends stops. */
export const IT_MAX_PAGES = 10;

/** The inbox expects the client to state its API version. */
const INBOX_HEADERS = { accept: "application/json", "x-api-version": "1" };

async function get(http: Http, url: URL, token: string) {
  return http.request(url, { headers: { ...INBOX_HEADERS, authorization: `Bearer ${token}` } });
}

/** One authenticated GET; a refused token is renewed once and the request repeated once. */
async function authedGet(http: Http, session: InPostSession, url: URL): Promise<Json> {
  let response = await get(http, url, await session.accessToken());
  if (response.status === 401) {
    response = await get(http, url, await session.refresh());
    if (response.status === 401) {
      throw new SignInRejectedError("InPost refused a freshly renewed token.");
    }
  }
  if (response.status !== 200) {
    throw new TransientError(`InPost's parcel inbox answered HTTP ${response.status}.`);
  }
  return readObject(response, "InPost's parcel inbox");
}

function parcelsOf(payload: Json): Json[] {
  const parcels = payload["parcels"];
  if (!Array.isArray(parcels)) {
    throw new UnexpectedResponseError("InPost's parcel inbox has no parcel list.");
  }
  return (parcels as unknown[]).filter(isObject);
}

export interface Inbox {
  readonly parcels: readonly Json[];
  /** False when the Italian inbox had more pages than the cap. */
  readonly complete: boolean;
}

/** Reads every parcel addressed to the account, from the market's own backend. */
export async function readInbox(
  http: Http,
  session: InPostSession,
  market: Market,
): Promise<Inbox> {
  if (market === "PL") {
    return {
      parcels: parcelsOf(await authedGet(http, session, new URL(PL_INBOX_URL))),
      complete: true,
    };
  }
  const parcels: Json[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < IT_MAX_PAGES; page += 1) {
    const url = new URL(IT_INBOX_URL);
    url.searchParams.set("role", "RECEIVER");
    if (cursor !== null) {
      url.searchParams.set("pagingState", cursor);
    }
    const payload = await authedGet(http, session, url);
    parcels.push(...parcelsOf(payload));
    cursor = text(asObject(payload["nextPage"])["pagingState"]);
    if (cursor === null) {
      return { parcels, complete: true };
    }
  }
  return { parcels, complete: false };
}
