# Research: completing app-only (custom-scheme) OAuth sign-ins from the web UI

Status: research only, 2026-11-19. No carrier endpoint was contacted.

## Problem

Some carriers only expose the mobile app's public OAuth client (authorization code + PKCE). Its
`redirect_uri` is a custom scheme (`dhllogin://de.deutschepost.dhl/login`). The final 302 to that
scheme goes to a URL the browser cannot open. Browsers drop it without telling the user, so they
never see the `code`. Today the user has to open DevTools → Network and copy the `Location` header.
DHL makes it worse: after "login successful" its widget does not go on to `/authorize`.

## Carriers affected (from `server/src/carriers`)

| Carrier | redirect_uri | Kind |
| :--- | :--- | :--- |
| DHL DE | `dhllogin://de.deutschepost.dhl/login` (`dhl/constants.ts:20`) | custom scheme, Akamai Identity Cloud + bot manager, optional email 2FA |
| DAO | `daoapp://auth-callback` (`dao/session.ts:26`) | custom scheme |
| PostNord | `com.postnord.app://redirect` (`postnord/account.ts:29`) | custom scheme |
| Posten / Bring | `posten://login`, `bring://login` (`posten_bring/index.ts:39-40`) | custom scheme |
| InPost, Mondial Relay, PostNL, Swiss Post | https callback on the carrier's own host | paste-back of an https URL; the page is visible, so this is easier but still manual |
| Cargus, Posti, USPS Informed | https, driven server-side | no paste-back needed |

That makes **5 custom-scheme flows and 4 https paste-back flows**. Whatever we build should be one
generic "interactive OAuth" mechanism keyed by `{authorizeUrl, redirectUri prefix}` per carrier,
not something written for DHL alone.

## Options

### 1. Server-side reverse proxy of the login pages
open-parcels would serve `login.dhl.de` under its own origin and rewrite HTML, JS, cookies and
`Location`. When it sees the 302 to `dhllogin://`, it keeps the code.
- **Bot protection:** poor. Akamai Bot Manager's sensor JS fingerprints the origin, TLS (JA3/JA4)
  and header order. Requests come from the server's IP using Node's TLS stack, not the browser's.
  Rewritten script origins break its integrity checks. Expect blocks and a constant game of catch-up.
- **Technical:** cookie domains, CSP, absolute URLs inside JS bundles, CORS on the Janrain capture
  API, and WebAuthn/2FA all need rewriting. That is fragile, and each carrier needs its own work.
- **Security/legal:** the password goes through open-parcels. This is a phishing-shaped proxy that
  users have to trust. It could be held in memory only, but it would still look like credential
  interception. It is also the most likely option to break the ToS.
- **Verdict:** not recommended.

### 2. Remote headless browser (Playwright/Chromium + screencast/noVNC/neko)
- **Bot protection:** better than the proxy, because it runs a real Chromium engine. Headless
  Chromium is still detected by Akamai, and the server or datacenter IP is still used. Headful Chromium
  under Xvfb does better.
- **Interception:** easy and reliable. `page.on('request')` or CDP `Fetch.requestPaused` sees the
  navigation to `dhllogin://` and can take the code.
- **Cost:** Chromium adds roughly 300–450 MB to the image and needs 200–500 MB RAM per session.
  That does not fit the 384 MB cap. It would have to be an optional sidecar such as
  `browserless/chromium` or neko, started only when needed.
- **Security:** the password is typed into a browser the server controls, so open-parcels can read
  it. Streaming keyboard input over the web UI also adds attack surface.
- **Verdict:** feasible as an optional sidecar for power users. Too heavy to be the default.

### 3. Browser extension (or userscript) that captures the redirect
The user signs in on the real carrier page in their own browser, so first-party cookies, their
residential IP and their real fingerprint are used. Bot managers see a normal user.
- **Capture:** with MV3, `chrome.webRequest.onBeforeRedirect` (or `onErrorOccurred` with
  `net::ERR_UNKNOWN_URL_SCHEME`) carries `redirectUrl` / `url` for the custom scheme. Firefox has the
  same API. A `declarativeNetRequest` redirect rule could instead rewrite `dhllogin://…` to
  `https://<open-parcels>/api/oauth/callback?...`. This is simpler, but the scheme-matching support
  has to be checked per browser, so prefer webRequest observation.
- **Handoff:** the extension posts `{state, url}` to open-parcels, or opens the open-parcels tab
  with the URL in a fragment. `state` ties it to the pending PKCE verifier on the server, so a stray
  code cannot be injected.
- **Userscripts/bookmarklets** cannot see the 302 `Location` (it is cross-origin and handled by the
  network stack), so they do not work. Only an extension does.
- **Security:** best. open-parcels never sees the password. The extension needs host permissions
  only for the listed login hosts and the user's open-parcels origin.
- **Cost:** no container cost. We would publish and maintain an extension: AMO for Firefox, the
  Chrome Web Store (or unpacked install) for Chromium. It does not help on mobile, except Firefox
  Android, which supports extensions.
- **Verdict:** the most robust and secure option that needs little effort per carrier.

### 4. Protocol handlers
- `navigator.registerProtocolHandler` only accepts `web+*` and a fixed safelist (`mailto`,
  `magnet`, …). It cannot claim `dhllogin:`. PWA `protocol_handlers` has the same limit.
- An OS-level handler (an `.desktop` file, a Windows registry entry, or a tiny native helper) works
  per machine. It needs an install, is OS-specific and is unsafe, because any site can trigger it.
- **Verdict:** not feasible for a web app. At most it could be an advanced helper script in the docs.

### 5. Official / alternative flows
- None of these app clients offer the device-code grant (RFC 8628) or a web redirect. The redirect
  URIs are fixed when the client is registered, so we cannot change them.
- Other projects:
  - The HA parcel integrations (`ha-parcel-integrations`), pyDHL-style libraries and similar
    community code use the same paste-the-redirect-URL step, or capture the refresh token once
    by hand.
  - Commercial trackers (Parcel app, 17track, AfterShip) use public tracking or partner/email
    APIs. They do not sign in to user accounts this way.
  - Nobody publicly offers anything better than paste-back plus an extension or helper.
- What works in our favour: once we have the code, the refresh token keeps working for a long
  time. A login is a rare, one-time event per account, so a small amount of friction is acceptable.

### 6. Better guided paste-back (no new components)
- Open `/authorize` in a popup. For DHL, after "login successful", automatically offer a second
  button that reopens `/authorize` **without** `prompt=login`. The SSO cookie now exists, so DHL
  sends the 302 right away.
- The popup cannot read the cross-origin URL, and browsers swallow unknown schemes. Firefox shows
  an error page whose address bar contains the full URL, and Chromium shows nothing. Give
  browser-specific steps with screenshots: Firefox can copy from the error page; in Chrome open
  `view-source:`, or DevTools → Network → "Preserve log" and filter for the scheme name.
- Accept the pasted text loosely. Pull `code` and `state` out of any blob, including a whole copied
  HAR line or a cURL, and check `state` against the pending session.
- **Verdict:** cheap and works for everyone. It should always stay as the fallback.

## Ranking

| Option | User ease | Security (password exposure) | Bot-protection robustness | Effort | Container cost |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 3 Extension | ★★★★★ (one click after install) | ★★★★★ never seen | ★★★★★ real browser/IP | medium, generic | none |
| 6 Guided paste-back | ★★☆ | ★★★★★ | ★★★★★ | low | none |
| 2 Remote browser sidecar | ★★★★ | ★★☆ server sees keystrokes | ★★★ (datacenter IP, automation flags) | high | +400 MB image, +300 MB RAM |
| 1 Reverse proxy | ★★★★ when it works | ★☆ password via server | ★ Akamai breaks it | very high, per carrier | small |
| 4 Protocol handler | ★ | ★★ | ★★★★★ | medium per OS | none |
| 5 Device code | n/a (not offered) | – | – | – | – |

## Recommendation

1. **Now:** make Option 6 the generic baseline for all 9 paste-back carriers. That means the popup,
   the DHL "continue" re-authorize step, browser-specific instructions and tolerant parsing.
2. **Next:** ship an **open-parcels companion extension** (Option 3) that upgrades the same flow to
   a zero-copy one when it is installed.
3. **Skip** the reverse proxy. Keep the remote browser as a possible separate, optional sidecar
   only if users ask for it.

## Sketch of the recommended design

```
Web UI                         open-parcels server                 Carrier
  │ start sign-in (carrier X)    │                                   │
  ├────────────────────────────▶│ create pending {state, verifier,  │
  │◀── {authorizeUrl, state,     │  redirectPrefix, expires 10 min}  │
  │     redirectPrefix}          │                                   │
  │ window.postMessage(          │                                   │
  │  {op:"arm", state, prefix})  │                                   │
  │  ──▶ extension content script on the open-parcels origin          │
  │ window.open(authorizeUrl) ───────────────────────────────────────▶│ user signs in, 2FA
  │                               extension webRequest sees           │
  │                               redirect to dhllogin://…?code&state ◀┤ 302
  │◀── extension: postMessage({op:"captured", url}) (state matches)   │
  ├── POST /sign-in/complete {url} ▶ check state, PKCE exchange ─────▶│ /token
  │                               store refresh token (SecretBox)     │
```

- **Generic carrier contract:** each interactive carrier exports
  `interactive: { authorizeUrl(state, challenge), redirectPrefix, reauthorizeUrl?(state) }`. The
  current `sign_in` paste types become one `oauth_redirect` type. The UI and the extension key off
  `redirectPrefix`.
- **Extension:**
  - MV3, permissions: `webRequest` plus host permissions for the carrier login hosts (an allow-list
    built into the extension, refreshed per release) and the user's open-parcels origin, which is
    granted at runtime with `permissions.request`.
  - It only acts while armed by a matching `state`, and only forwards URLs that start with the
    armed prefix.
  - It never touches the page content of the login sites.
- **Fallback:** if the extension does not answer the `arm` ping within 300 ms, the UI shows the
  guided paste-back of Option 6.
- **Security:**
  - The server enforces `state`, single use and a 10-minute expiry.
  - The PKCE verifier never leaves the server.
  - Codes are not logged.
  - No password ever reaches open-parcels.
