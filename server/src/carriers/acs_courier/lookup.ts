import {
  type PluginHttp,
  asArray,
  isObject,
  RateLimitedError,
  readObject,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type SessionStore,
} from "../../plugin/api.js";

export const API_HOST = "api.acscourier.net";
export const SITE_HOST = "www.acscourier.net";
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const TRACKING_PAGE = `${SITE_ORIGIN}/en/quick-access/non-registered-users/track-and-trace/`;

const TOKEN_PATTERN = /publictoken\s*=\s*["']([^"']+)["']/i;
const NOT_FOUND_NOTE = "Shipment not found";
/** After the lookup is refused twice in a row, wait this long before trying again. */
export const REFUSED_PAUSE_SECONDS = 30 * 60;

/** The public page embeds a token the lookup API wants; it is cached in the source's session. */
async function freshToken(http: PluginHttp): Promise<string> {
  const response = await http.request(new URL(TRACKING_PAGE), {
    headers: { accept: "text/html" },
  });
  if (response.status !== 200) {
    throw new TransientError(`ACS Courier's tracking page answered HTTP ${response.status}.`);
  }
  const token = TOKEN_PATTERN.exec(response.body)?.[1];
  if (token === undefined) {
    throw new UnexpectedResponseError("ACS Courier's tracking page carried no lookup token.");
  }
  return token;
}

function storedToken(session: SessionStore): string | null {
  const stored = session.load();
  return isObject(stored) && typeof stored["token"] === "string" ? stored["token"] : null;
}

async function ask(http: PluginHttp, barcode: string, token: string) {
  // The API answers an unknown Origin with a 404 that looks like a miss, so the site is named.
  return http.request(
    new URL(`https://${API_HOST}/api/parcels/search/${encodeURIComponent(barcode)}`),
    {
      headers: {
        accept: "application/json",
        "x-encrypted-key": token,
        "x-country": "GR",
        origin: SITE_ORIGIN,
        referer: `${SITE_ORIGIN}/`,
      },
    },
  );
}

/** What one run has done with the lookup token: it is fetched from the page at most once. */
export interface TokenRun {
  fetched: boolean;
}

/**
 * Looks one code up. A refused token is replaced from the public page once per run; a token
 * refused after that pauses lookups instead of hammering the page. Returns null when ACS does
 * not know the code.
 */
export async function lookUp(
  http: PluginHttp,
  session: SessionStore,
  barcode: string,
  run: TokenRun = { fetched: false },
): Promise<Json | null> {
  const fetch = async (): Promise<string> => {
    run.fetched = true;
    return freshToken(http);
  };
  let token = storedToken(session) ?? (await fetch());
  let response = await ask(http, barcode, token);
  if ((response.status === 401 || response.status === 403) && !run.fetched) {
    token = await fetch();
    response = await ask(http, barcode, token);
  }
  if (response.status === 401 || response.status === 403) {
    await session.save(null);
    throw new RateLimitedError("ACS Courier refused a fresh lookup token.", REFUSED_PAUSE_SECONDS);
  }
  await session.save({ token });
  const isJson = (response.headers.get("content-type") ?? "").toLowerCase().includes("json");
  if (response.status === 404 && isJson) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`ACS Courier tracking answered HTTP ${response.status}.`);
  }
  const items: unknown = readObject(response, "ACS Courier tracking")["items"];
  if (!Array.isArray(items)) {
    throw new UnexpectedResponseError("ACS Courier tracking answered without an item list.");
  }
  const item = asArray(items)[0];
  if (item === undefined) {
    return null;
  }
  if (!isObject(item)) {
    throw new UnexpectedResponseError(
      "ACS Courier tracking listed something that is not a parcel.",
    );
  }
  return item["notes"] === NOT_FOUND_NOTE ? null : item;
}
