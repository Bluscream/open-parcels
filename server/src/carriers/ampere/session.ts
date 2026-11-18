import {
  type PluginHttp,
  asObject,
  CookieJar,
  isObject,
  readJson,
  RateLimitedError,
  SignInRejectedError,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
} from "../../plugin/api.js";

export const HOST = "bol.prd.amperebezorgt.nl";
const BASE = `https://${HOST}`;
const COOKIE = "tnt_sessions";
const PARCEL_PATH = /\/nl\/parcel\/([^/?#]+)/;
/** The error page's own markers. Its Dutch text is bundled on every page, so text proves nothing. */
const ERROR_MARKERS = ['data-test-id="error-title"', 'data-test-id="error-message"'];

/** A guest session for one parcel, minted by following the e-mail link once. */
export interface GuestSession {
  readonly cookie: string;
  readonly parcelToken: string;
}

/** The e-mail link was refused: used up, malformed or expired. Only a new link helps. */
export class DeadLinkError extends SignInRejectedError {}

/** The link starts at the shop's redirector and lands on the Ampère tracker. */
function allowedHop(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    (target.hostname === "link.bol.com" ||
      target.hostname === "amperebezorgt.nl" ||
      target.hostname.endsWith(".amperebezorgt.nl"))
  );
}

/** A dead session still answers 200, with the "open the link from your e-mail again" page. */
const isErrorPage = (body: string): boolean =>
  ERROR_MARKERS.some((marker) => body.includes(marker));

/**
 * Follows the e-mail link and keeps the session cookie and the parcel token it lands on. The
 * page it lands on is the parcel page, so it is returned too (null if it is the error page).
 */
export async function exchange(
  http: PluginHttp,
  link: string,
): Promise<{ session: GuestSession; html: string | null }> {
  let start: URL;
  try {
    start = new URL(link);
  } catch {
    throw new DeadLinkError("An Ampère tracking link is not a valid address.");
  }
  if (!allowedHop(start)) {
    throw new DeadLinkError("An Ampère tracking link points somewhere unexpected.");
  }
  const jar = new CookieJar();
  const response = await http.request(start, { jar, allowRedirect: allowedHop });
  if ([400, 401, 403, 404, 410].includes(response.status)) {
    throw new DeadLinkError(`Ampère refused a tracking link (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new TransientError(`Ampère answered HTTP ${response.status} for a tracking link.`);
  }
  const parcelToken = PARCEL_PATH.exec(response.url)?.[1];
  if (parcelToken === undefined) {
    throw new UnexpectedResponseError("An Ampère tracking link landed on an unexpected page.");
  }
  const cookies = await jar.getCookies(response.url);
  const cookie = cookies.find((entry) => entry.key === COOKIE)?.value;
  if (cookie === undefined) {
    throw new UnexpectedResponseError("Following an Ampère tracking link set no session.");
  }
  return {
    session: { cookie, parcelToken },
    html: isErrorPage(response.body) ? null : response.body,
  };
}

/** The server-rendered parcel page, or null when the session is no longer accepted. */
export async function parcelPage(http: PluginHttp, session: GuestSession): Promise<string | null> {
  const response = await http.request(new URL(`${BASE}/nl/parcel/${session.parcelToken}`), {
    headers: { cookie: `${COOKIE}=${session.cookie}`, accept: "text/html" },
    redirect: "manual",
  });
  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (response.status !== 200) {
    throw new TransientError(`Ampère's parcel page answered HTTP ${response.status}.`);
  }
  return isErrorPage(response.body) ? null : response.body;
}

/**
 * The delivery window, best effort: the page alone carries everything the status needs, so a
 * failure here never fails the run. A rate limit is still passed on.
 */
export async function deliveryWindow(http: PluginHttp, session: GuestSession): Promise<Json> {
  try {
    const url = new URL(`${BASE}/api/progress`);
    url.searchParams.set("sid", session.parcelToken);
    const response = await http.request(url, {
      headers: { cookie: `${COOKIE}=${session.cookie}`, accept: "application/json" },
    });
    if (response.status !== 200) {
      return {};
    }
    const window = asObject(asObject(readJson(response, "Ampère progress"))["data"])[
      "deliveryWindow"
    ];
    return isObject(window) ? window : {};
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw error;
    }
    return {};
  }
}

export function storedSession(value: unknown): GuestSession | null {
  const stored = asObject(value);
  const cookie = text(stored["cookie"]);
  const parcelToken = text(stored["parcelToken"]);
  return cookie === null || parcelToken === null ? null : { cookie, parcelToken };
}
