# open-parcels companion extension: page protocol (v1)

Some carriers only offer a phone-app sign-in. Their last redirect goes to an address a browser
cannot open (`dhllogin://…?code=…`) or to a callback page the user would have to copy by hand.
The companion extension catches that address in the sign-in tab and hands it to the open-parcels
web UI, which submits it like a pasted address. The server checks `state`, so a stray code is
refused. The extension never sees or sends passwords; the user signs in on the carrier's own page.

## Discovery

The web UI's `index.html` carries `<meta name="open-parcels" content="web-ui">`. The extension's
content script runs on every page but does nothing unless that tag is present.

All messages use `window.postMessage(message, window.location.origin)` in the open-parcels tab,
and every receiver checks `event.source === window` and `event.origin === location.origin`.

## Messages

Page → extension (`source: "open-parcels-page"`):

| `type`    | Fields                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `hello`   | –                                                                      |
| `capture` | `requestId` (string), `url` (https), `redirectPrefix` (string), `resumeUrl` (https or null) |
| `cancel`  | `requestId`                                                            |

Extension → page (`source: "open-parcels-extension"`):

| `type`      | Fields                                                     |
| ----------- | ---------------------------------------------------------- |
| `hello`     | `version` (string), `protocol: 1`                          |
| `captured`  | `requestId`, `url` (the full redirect address)             |
| `cancelled` | `requestId`, `reason`: `closed`, `denied`, `invalid` or `timeout` |

The page sends `hello` on load and treats the extension as present when an answer arrives within
500 ms.

## Rules for `capture`

1. **Origin approval.** The first `capture` from a page origin asks the user to allow that
   open-parcels address (stored per origin; revocable in the extension's options). Refused →
   `cancelled` with `denied`.
2. **Validation.** `url` and `resumeUrl` must be `https:`. `redirectPrefix` must be a URL prefix
   with a scheme. Otherwise → `cancelled` with `invalid`.
3. The extension opens `url` in a new popup window (or tab) and watches **only that tab**.
4. The first navigation or redirect in that tab whose address starts with `redirectPrefix`
   (from `webRequest.onBeforeRedirect` `redirectUrl`, `webRequest.onBeforeRequest`,
   `webNavigation.onBeforeNavigate`/`onErrorOccurred`, or `tabs.onUpdated`) is the result: close
   the window, send `captured`, stop watching.
5. **Resume.** Some login pages finish with a blank page after a successful sign-in (DHL). When
   `resumeUrl` is set and a main-frame `POST` in the tab completes without a capture within
   3 seconds, navigate the tab to `resumeUrl` (at most 3 times per request).
6. The user closing the tab → `cancelled` with `closed`. After 15 minutes → `timeout`.
7. Nothing is stored except the approved origins. Captured addresses live only in memory until
   they are sent.
