/** Endpoints and fixed values of the DHL back ends this plug-in talks to. */

export const GATEWAY_URL = "https://api-gw.dhlparcel.nl/track-trace";
/** Codes per gateway request; a long list is split rather than sent as one huge query. */
export const GATEWAY_BATCH = 20;

export const UNIFIED_URL = "https://api-eu.dhl.com/track/shipments";

export const DE_OIDC_ROOT = "https://login.dhl.de/af5f9bb6-27ad-4af4-9445-008e7a5cddb8/login";
export const DE_DISCOVERY_URL = `${DE_OIDC_ROOT}/.well-known/openid-configuration`;
/**
 * The sign-in start has no network access, so the authorization endpoint cannot be discovered
 * there; it is the tenant's standard path. The token endpoint is always discovered.
 */
export const DE_AUTHORIZE_URL = `${DE_OIDC_ROOT}/authorize`;
/** The DHL Paket app's public client; it authenticates with an empty Basic-auth secret. */
export const DE_CLIENT_ID = "83471082-5c13-4fce-8dcb-19d2a3fca413";
export const DE_REDIRECT_URI = "dhllogin://de.deutschepost.dhl/login";
export const DE_SCOPE = "openid offline_access";
/** The claim that links a token to its account; without it the inbox is silently empty. */
export const DE_ACCOUNT_CLAIM = "post_number";
/** Without asking for these ID-token claims the inbox endpoint answers with an empty list. */
export const DE_LOGIN_CLAIMS = JSON.stringify({
  id_token: {
    email: null,
    post_number: null,
    twofa: null,
    service_mask: null,
    deactivate_account: null,
    last_login: null,
    customer_type: null,
    display_name: null,
    data_confirmation_required: null,
  },
});
/**
 * The token endpoint rejects generic clients; it is sent the app's own headers. Only for
 * login.dhl.de and www.dhl.de; every other host gets the honest default User-Agent.
 */
export const DE_TOKEN_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://login.dhl.de",
  "user-agent": "DHLPaket_PROD/1367 CFNetwork/1240.0.4 Darwin/20.6.0",
  "accept-language": "de-de",
};
export const DE_TRACKING_URL = "https://www.dhl.de/int-verfolgen/data/search";
export const DE_TRACKING_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};
/** The ID token travels in this cookie, to www.dhl.de only. */
export const DE_COOKIE_NAME = "dhli";
export const DE_PUBLIC_TRACKING_URL =
  "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html";
/** Refresh a cached ID token this long before it expires. */
export const DE_TOKEN_MARGIN_MS = 5 * 60_000;
/** Lifetime assumed when a token response has no `expires_in`. */
export const DE_TOKEN_LIFETIME_MS = 30 * 60_000;
/** Stub inbox entries looked up by number per run, at most. */
export const DE_ENRICH_LIMIT = 5;
export const BERLIN = "Europe/Berlin";

export function publicTrackingUrl(code: string): string {
  return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${encodeURIComponent(code)}`;
}

export function germanTrackingUrl(code: string): string {
  return `${DE_PUBLIC_TRACKING_URL}?piececode=${encodeURIComponent(code)}`;
}
