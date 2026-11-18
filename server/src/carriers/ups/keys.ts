/*
 * Fixed values for the UPS plug-in: hosts, request headers, User-Agent strings and the measured
 * request budget of the public tracking.
 *
 * The browser identity (User-Agent and its client hint) is read from the shared rules.
 */

import { carrierKey } from "../../plugin/api.js";

export const PUBLIC_HOST = "webapis.ups.com";
export const OFFICIAL_HOST = "onlinetools.ups.com";

/**
 * The public tracking endpoint. A GET to it (it only accepts POST) falls through to the tracking
 * app's shell and seeds the session cookies, including the CSRF one; the POST answers the lookup.
 * The GET is aimed here rather than at www.ups.com because the www host answers some clients with
 * a bot-manager challenge page that seeds no CSRF cookie at all.
 */
export const PUBLIC_TRACK_PATH = "/track/api/Track/GetStatus";

/** The CSRF cookie the bootstrap sets, and the header its value is copied into verbatim. */
export const COOKIE_XSRF = "X-XSRF-TOKEN-ST";
export const HEADER_XSRF = "X-XSRF-TOKEN";

/** `trackDetails[0].errorCode` for a number UPS does not know. Answered with HTTP 200. */
export const NOT_FOUND_ERROR_CODE = "504";

export const DEFAULT_LOCALE = "en_US";
/** Locales UPS is known to answer; anything else falls back to the default. */
export const LOCALES = ["en_US", "en_NL"] as const;

export function publicTrackingUrl(code: string, locale: string): string {
  const url = new URL("https://www.ups.com/track");
  url.searchParams.set("loc", locale);
  url.searchParams.set("tracknum", code);
  return url.toString();
}

/**
 * The browser identity the public tracking is scored against. The guard checks that the client
 * hints below agree with this User-Agent; change the version in both rules keys together or not
 * at all. If lookups start hanging, bumping this triplet is the first thing to try.
 */
export const BROWSER_USER_AGENT = carrierKey("ups", "browser_user_agent");

/** Why the plug-in sends browser headers; shown in diagnostics. */
export const BROWSER_HEADERS_REASON =
  "UPS's public tracking sits behind a bot guard that never answers (the request hangs until it " +
  "times out) unless the request carries a Chrome User-Agent with matching client-hint headers.";

/** Sent to UPS's official API, which needs no disguise. */
export const HONEST_USER_AGENT = "open-parcels/2 (+https://github.com/Bluscream/open-parcels)";

/**
 * The client-hint headers the guard scores for a Chrome identity. All four are required together:
 * dropping any one makes every lookup hang. Do not trim this set.
 */
const GUARD_HEADERS: Readonly<Record<string, string>> = {
  "accept-encoding": "gzip, deflate, br",
  "sec-ch-ua": carrierKey("ups", "browser_client_hint"),
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "user-agent": BROWSER_USER_AGENT,
};

/** The bootstrap GET keeps a top-level navigation's shape: no Origin, no Referer. */
export const NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  ...GUARD_HEADERS,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
};

/** The lookup POST is a same-site fetch from the tracking page. */
export const FETCH_HEADERS: Readonly<Record<string, string>> = {
  ...GUARD_HEADERS,
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  origin: "https://www.ups.com",
  referer: "https://www.ups.com/",
};

/** An Accept-Language that agrees with the locale sent, as a browser in that locale would send. */
export function acceptLanguage(locale: string): string {
  const [language = "en", country] = locale.split("_");
  return country === undefined
    ? `${language},${language};q=0.9`
    : `${language}-${country},${language};q=0.9`;
}

/**
 * The guard hangs instead of refusing, so every public request needs its own timeout. The slowest
 * hang seen before giving up was about 14 s.
 */
export const PUBLIC_TIMEOUT_MS = 20_000;

/**
 * UPS does not throttle a rate, it grants a count: about three answered requests per address,
 * after which every further request hangs until the address has rested.
 */
export const BUDGET_CAPACITY = 3;
/**
 * Rest per request earned back. The measured beat is an hour, but one beat in seven is skipped
 * and an early request costs a hang plus a long stand-down, so this sits past it.
 */
export const BUDGET_REFILL_MS = 4_500_000;

/** Shortest gap between two public lookups, whatever asked for the run. */
export const MIN_CYCLE_GAP_MS = 300_000;

/**
 * Stand-down after a failed public lookup: base × 2^failures, capped, and never shorter than a
 * refill. The address was measured still closed at 78 minutes and open again at 113.
 */
export const BACKOFF_BASE_MS = 3_600_000;
export const BACKOFF_CAP_MS = 21_600_000;

/** Above this many waiting codes each one refreshes only about every half day; warn once. */
export const TRACKED_CODE_SOFT_LIMIT = 10;

/** Fewest refill intervals a code may fall behind before its status stops holding it back. */
export const MIN_OVERDUE_INTERVALS = 3;

/** Official API access tokens are renewed this long before they expire. */
export const TOKEN_MARGIN_MS = 60_000;
