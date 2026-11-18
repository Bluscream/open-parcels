# 0001: Rebuild open-parcels as the single parcel-tracking backend

- **Status:** accepted 2026-11-18. Revision 2 follows the owner's answers: TypeScript, one user per
  container, Docker Hub and GHCR, and a consolidated rules repo.
- **Supersedes:** revision 1 of this record, which proposed a Python backend. It is in git history.

## 1. Context

open-parcels was dormant from September 2026. Meanwhile the parcel logic that actually works was
built as Home Assistant integrations: carrier sign-ins, status vocabularies, adaptive polling,
live courier tracking, calendars and the map. The goal now is to make open-parcels the one place
where tracking happens. It is a Docker container that:

- signs in to carriers and polls them;
- reads mail;
- follows couriers live;
- resolves places;
- stores history and publishes events.

A later Home Assistant integration only displays what it publishes. The code must hold up for
many installations, not just this one. Those run on Docker, Unraid, and a Home Assistant app on a
Raspberry Pi.

### What the audit found

**The existing TypeScript code**

- About 4.8k backend lines, 6.7k React frontend lines and 2.9k script lines.
- **No carrier logic of its own.** Every lookup went to a separate service, universal-lookup.
- **No scheduler.** IMAP polling and parcel refresh were never triggered automatically.
- **Security problems:**
  - GET requests need no token.
  - `/admin/db-backup` returns the whole database to anyone.
  - The WebSocket streams every log line without authentication.
  - Mail rules are downloaded and run with `node:vm`.
  - The encryption key silently falls back to a random one.
- **Schema push at every boot.** There are no versioned migrations.
- **The image can't run Playwright.** It also runs as root and has no healthcheck.
- **Worth keeping:**
  - the React map pieces: `mapIcons`, `AnimatedRoute`, `SharedMap`, `SplitContainer`;
  - `DataTable`;
  - the knowledge of Amazon's live endpoints.

**The Home Assistant suite** has 87 carrier repos written in Python with aiohttp.

- **The carrier transports are separable.** They take an injected HTTP session and don't import
  Home Assistant.
- **Carrier logic is 25–60 % of each repo.**
- **The newer techniques live in the fork and PR worktrees:**
  - live courier tracking;
  - the `parcel_removed` grace period;
  - calendar narrowing;
  - place lookup;
  - carrier hand-off;
  - the order-line parsers.
- **Live tracking was proven on a real delivery** in a Home Assistant session on 2026-11-18. It
  read every 30 s, the stop count went down and back up, and the events carried no coordinates.

**Earlier rule repos of the owner's own** (`Bluscream/email-parser-rules` and
`Bluscream/mail-parser-ts`, both last touched 2026-06-11) hold mail rules as TypeScript modules
with `parse()` functions. There are 25 rules across parcel, order, return and dunning mails.

**Prior art: nothing covers the whole job.**

| Project | Strength | Gap |
|---|---|---|
| *Dude, Where's My Package* | Closest architecture: Docker, API, HA app and integration | Dutch-focused; no Hermes, IMAP, map or ICS |
| *Paket Tracker* | Best German mail rules, plus an anonymised `.eml` corpus | Runs only inside Home Assistant |
| *jkeen/tracking_number_data* | The de-facto tracking-number dataset | No Hermes, GLS, PostNL or DHL Paket DE |

## 2. Decision

### 2.1 Rewrite the backend in TypeScript on Node; rebuild the React frontend on top of the old one

**The owner prefers TypeScript.** It also has real advantages here:

- **One language for server, web UI and rules engine.** Shared types replace hand-written mirrors.
  The old frontend and map code carry over directly.
- **The strongest static checking** of the candidate stacks: strict `tsc` plus type-aware
  linting.
- **imapflow is the best IMAP IDLE client in any of the stacks**, and Playwright is first-class in
  Node if a carrier ever needs a browser.

**The old backend is not kept.** It has no carriers, no scheduler and a security model that has
to be redone. A clean structure costs less than fixing it. It stays on the `legacy-ts` branch and
the `v1-final` tag.

**The cost we accept:** carriers from the Python suite are re-implemented by hand in TypeScript.
They are written fresh against behaviour that is already proven, never copied. The rules repo
(§2.3) keeps vocabularies, patterns and locale tables language-neutral, so most of the knowledge
is shared anyway.

### 2.2 Main libraries

Versions are pinned and checked at install time.

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 26 LTS (`node:26-slim`, Debian/glibc) | Active LTS; glibc so native modules and Playwright work on arm64 |
| Language | TypeScript, strict (§6 of the TypeScript rules), on the newest release typescript-eslint supports with type-aware rules | TypeScript 7 still lacks type-aware lint support |
| Web framework | Fastify 5 with `fastify-type-provider-zod`, `@fastify/swagger` | Route types and OpenAPI come from one schema |
| Validation | zod 4 | API schemas and parsing of messy carrier payloads use the same tool |
| Database | SQLite (WAL) through better-sqlite3 + Kysely | Typed queries; migrations are code; no ORM magic. Drizzle was dropped because of its 0.x→1.0 migration churn and the memory measured during research |
| HTTP to carriers | undici (built-in `fetch`) by default; `impit` only for carriers that check the browser's TLS fingerprint | Each plug-in chooses its transport |
| HTML parsing | cheerio | |
| Scheduler | Our own: a heap of next-run times, token buckets, backoff | The polling rules don't fit cron; testable with fake timers |
| IMAP | imapflow (IDLE) + mailparser | |
| ICS | ical-generator | |
| Push | Server-Sent Events | Clients only need one-way; `Last-Event-ID` replay is built in; works through HA ingress |
| MQTT | `mqtt`, optional, later phase | |
| Secrets | `node:crypto` AES-256-GCM; scrypt for the password | No native dependency |
| Logging | pino (Fastify's own logger), JSON, with `redact` paths and a value scrubber | |
| Tests | vitest, undici `MockAgent`, Fastify `inject`, fake timers, recorded made-up fixtures | |
| Web UI | React 19, Vite, TanStack Router + Query, OpenAPI-generated client (orval), Leaflet/react-leaflet, FullCalendar (month/week/day/list/multi-month), TanStack Table | |
| Browser (only if a carrier needs it) | Playwright Chromium in an optional `-browser` image variant | Most installs never download a browser |

### 2.3 Repositories

| Repo | Contents |
|---|---|
| `open-parcels` (this repo, npm workspaces) | `server/` (API, engine, carrier plug-ins), `web/` (UI), Dockerfile, Unraid template |
| **`open-parcels-rules`** (`email-parser-rules` renamed; `mail-parser-ts` merged in with its history, then archived) | Language-neutral data plus a TypeScript engine, published as an npm package and a JSON bundle. See the list below |
| `open-parcels-ha-apps` (later) | The Home Assistant app repository. It is separate because the Marketplace refuses repositories that contain apps |
| `open-parcels-ha` (later, not part of this task) | The thin integration, installed from the Marketplace. **One coherent "Open Parcels" integration** (owner's decision, 2026-11-18), unlike the one-repo-per-carrier suite: a Home Assistant device per provider and account (one per open-parcels source), with the parcels as that device's entities |

`open-parcels-rules` holds:

- **Tracking-number patterns.** jkeen's dataset is the pinned upstream, with our EU overlay in the
  same schema.
- **Carrier status tables**, mapped to the canonical status list.
- **Locale tables** for delivery dates and windows.
- **Declarative mail rules**, kept as data wherever a rule can be expressed that way.
- **Place-extraction patterns and tracking-URL templates.**
- **Shared tooling:**
  - a JSON Schema for every file;
  - test vectors per rule;
  - a lint that keeps every regex in a portable subset (no lookaround, no backreferences), so
    Python and other consumers can use the same files.

The app consumes `open-parcels-rules` as a versioned dependency. Rules are **never** downloaded and
run at runtime.

The carrier plug-ins live in `server/src/carriers/` behind a lint-enforced boundary: they import
only the plug-in API. Once that API settles they can split out into their own package.

### 2.4 Architecture

```
               ┌──────────────── open-parcels container ────────────────┐
  Web UI ─────►│ Fastify  /api/v1 (REST, OpenAPI)   /api/v1/events (SSE)│◄── HA integration
  HA ingress ─►│          /ical/{token}.ics         /img/{signed-id}    │◄── calendar apps
               │      │                                                 │
               │  Services: parcels · events · calendar · places · auth │
               │      │                     ▲                           │
               │  Scheduler ──► Source runners (one per source)        │
               │   (tiers, quiet window,     │  carrier plug-ins:       │
               │    token buckets, backoff)  │  account / tracking /    │
               │  Live tracker (30 s / 5 min)│  shop / live / mail      │
               │  Mail watcher (IMAP IDLE) ──┘                          │
               │      │                                                 │
               │  Reconciler: merge snapshots → parcels, dedup and      │
               │  hand-off, status fallback, event rules, outbox        │
               │      │                                                 │
               │  SQLite (/data/openparcels.db), secrets (AES-GCM)      │
               └────────────────────────────────────────────────────────┘
```

#### Plug-in contract

Each carrier is a module that declares:

- metadata: id, name, countries, capabilities, and the source kinds it offers;
- a zod config schema, which the UI renders as a form;
- its sign-in flows (see below);
- its rate-limit policy;
- async methods that return `ParcelSnapshot` objects.

Plug-ins never touch the database and never send events.

**Sign-in flows.** A plug-in declares one flow or a list of them. Each flow may be limited to some
source kinds (`kinds`) and to some configurations (`when(config)`); the first applicable flow is
the default. DHL, for example, signs a German account in by pasted link, a Dutch account
(`config.account = "nl"`) by email and password, and a tracking source by an optional API key.

- `none`, `credentials` and `api_key` are static: the UI renders the plug-in's secret schema as a
  form and stores what the user types.
- `interactive` flows run on the server, step by step, because open-parcels has its own UI and can
  ask several questions in a row. `start` and `continue` may call the carrier through the
  rate-limited plug-in HTTP client. Each call returns either the next step with the state to keep,
  or the finished secret, which is validated against the secret schema before it is stored.
- Step kinds and the input each takes:

  | Step | Shows | Input |
  |---|---|---|
  | `form` | fields (text, email, password, tel) | one value per field |
  | `open_url` | an address to open in the user's own browser | `pasted`: the address the browser ends on |
  | `email_link` | where the link went (masked) | `code`: the link or the code in it |
  | `otp_code` | channel (SMS, email, app) and masked destination | `code` |
  | `choose_method` | options | `choice`: an option id |
  | `await_approval` | message, poll interval, timeout | none; the UI polls |

- What a plug-in's error means: `SignInRejectedError` is a refused input (a wrong code); the
  attempt keeps its step so the user can try again. `TransientError`/`RateLimitedError` mean the
  carrier could not be reached; the attempt stays exactly as it was and is never restarted on its
  own. Any other error counts as a failed try. After five failed tries the attempt is dropped.
- The old pasted-redirect type is now the `pastedRedirect()` helper: an interactive flow with one
  `open_url` step.

The flow state lives in `sign_in_attempts` (§2.5), encrypted like `session_blob` and bound to the
attempt and its source, with an expiry of 15 minutes per step (an approval step uses its own
timeout, which polling does not extend). One attempt per source; a new start replaces it. The
state may hold cookies, PKCE verifiers or a typed password and is never logged; failures are
logged by error type only.

#### Reconciler

The reconciler is the only writer of parcels. It:

- merges the snapshots from all sources: for DHL the newest scan wins and other backends fill
  gaps;
- applies the suite's status rule: map the status, else take the newest history entry that maps,
  else `unknown`, with one warning per new value;
- handles hand-off: an Amazon parcel carried by DHL becomes one parcel with two sources;
- derives events by comparing old and new state, inside the same transaction that writes the
  outbox row.

#### Scheduler

It implements the suite's polling rules:

- **Quiet window:** 00:00–06:00, with catch-up anchors. On by default; one global opt-out
  (`OPENPARCELS_QUIET_WINDOW=false`, or the app option `quiet_window`), never per carrier.
- **Fast tier:** every 15 min for parcels out for delivery within an hour of `planned_from`.
- **Slow tier:** every 45 min for everything else.
- **Stagger** per install and per source.
- **On 429:** honour `Retry-After`, otherwise back off 60 s × 2ⁿ, up to 1 h.
- **Account-less sources stop** when they track nothing active.

On top of that:

- a token bucket per carrier host;
- at most one request at a time per account;
- **a network error never triggers a new sign-in.** Only an explicit rejection does, once. After
  that the source is marked "needs sign-in".

#### Live tracker

- Polls every 30 s while a map session is open.
- Probes every 5 min for out-for-delivery parcels that have no map yet.
- Stops after 3 failed passes, until the next full poll.
- Honours `Retry-After`, and never signs in again because of a network error.
- Refreshes the parcel immediately when the session reports delivered or ended.
- Keeps the courier's position in memory and in the current `live` value only. Positions are
  never written to history.

#### Mail watcher

- Uses IMAP IDLE on each configured folder.
- Each new message goes through, in order:
  1. schema.org `ParcelDelivery` markup, when present;
  2. the shop and carrier rules from `open-parcels-rules`;
  3. tracking-number detection, constrained by the sender and the surrounding text.
- Deduplicates by Message-ID.
- Never marks a mail as read unless the user opts in.

#### Browser

No first-wave carrier needs one. Amazon signs in by device registration with a pasted link, and
DHL DE by OIDC with a pasted link. If a later carrier needs a browser, it runs in the `-browser`
image variant:

- in a separate process;
- one browser at a time;
- with a hard timeout and a memory cap.

### 2.5 Data model (SQLite, Kysely migrations)

There is one owner per container, so tables carry no user column.

| Table | Key fields | Notes |
|---|---|---|
| `owner` | password_hash (scrypt), created_at | A single row, created by the setup page on first start |
| `api_tokens` | id, name, hash (SHA-256), scopes, last_used_at, expires_at | The token value is shown once |
| `sources` | id, plugin, kind (account/tracking/shop/mail), label, config (JSON), secret_blob (AES-GCM), session_blob (AES-GCM), state (ok/needs_sign_in/error/disabled), backoff fields, last_ok_at | One row per sign-in or mailbox |
| `parcels` | id (UUID), carrier, barcode, direction, status, raw_status, delivered, delivered_at, planned_from, planned_to, pickup, pickup_point, url, sender, receiver, weight, dimensions, label, order_id, manual_status, manual_until, first_seen_at, last_seen_at, removed_at, archived_at | Unique on (carrier, barcode). Nothing ever overwrites a manual override |
| `parcel_sources` | parcel_id, source_id, external_ref, role (primary/handoff/mail), last_seen_at | Hand-off and deduplication |
| `parcel_events` | id, parcel_id, source_id, at, status, raw_status, location_text, fingerprint (unique) | History. No coordinates |
| `parcel_raw` | parcel_id, source_id, fetched_at, payload (JSON) | The latest raw payload per source. Codes that open or sign in to something are stripped |
| `items` | id, parcel_id, title, image_ref, url, external_id, quantity, price, currency | |
| `orders` | id, shop, order_number, placed_at, status | |
| `live_state` | parcel_id, state, stops_away, message, position_at, updated_at | No coordinates |
| `places` | key (normalised text), lat, lng, precision, missed_at | Hits and misses are cached; misses are retried after 7 days |
| `outbox` | seq (monotonic), type, parcel_id, payload (JSON), created_at | Feeds SSE replay and, later, webhooks and MQTT |
| `unknown_vocab` | plugin, kind, key, first_seen_at, count | Drives the one-time "please report" warning. Keys only |
| `sign_in_attempts` | id, source_id, flow, blob (AES-GCM: plug-in state and current step), failures, expires_at, poll_not_before | Interactive sign-ins in progress; one per source, gone when finished, cancelled or expired |
| `settings`, `image_cache` | | |

**Retention defaults**, all configurable:

- delivered parcels are archived after 30 days and deleted after 365;
- undelivered parcels the carrier has answered "not found" for 30 days without a break
  (`lookup.state = not_found`) are archived, never deleted early and without `parcel.removed`;
  a manual status keeps them. `OPENPARCELS_NOT_FOUND_ARCHIVE_DAYS`, 0 turns it off;
- `parcel_raw` is dropped 30 days after delivery;
- the outbox is kept for 7 days;
- the image cache is capped at 200 MB.

### 2.6 API and event contract

#### REST

Everything is under `/api/v1`. The OpenAPI document is at `/api/v1/openapi.json`.

**Parcels**

- `GET /parcels`, with filters: status, carrier, active, delivered-within, q.
- `GET /parcels/{id}`, which adds history, items, sources, live and location.
- `POST /parcels` to track a code. The carrier is detected, or given by the caller.
- `PATCH /parcels/{id}` for the label, the manual status, or archiving.
- `DELETE /parcels/{id}`.
- `POST /parcels/{id}/refresh`.

**Sources**

- `GET`, `POST`, `PATCH` and `DELETE /sources`; `PUT /sources/{id}/secret` for static flows.
- `GET /sources/{id}/sign-in/flows`: the flows that apply to this source, the default first.
- `POST /sources/{id}/sign-in/attempts` with an optional `{flow}` starts an interactive sign-in and
  returns `{status: "step", attempt_id, flow, expires_at, step}`.
- `POST /sources/{id}/sign-in/attempts/{attempt}/continue` with `{input}` answers the current step
  and returns the next one or `{status: "done"}`; the secret is then stored and the source runs.
- `POST /sources/{id}/sign-in/attempts/{attempt}/poll` checks an `await_approval` step. Calls
  closer together than the step's interval get 429 with `Retry-After`; after its timeout the
  attempt ends with `sign_in_timeout`.
- `DELETE /sources/{id}/sign-in/attempts/{attempt}` cancels.
- Errors: `sign_in_refused` (400, try the step again), `sign_in_unavailable` (503, carrier
  unreachable, the step is kept), `sign_in_failed` (400), `sign_in_expired` (400: expired,
  cancelled, tampered with or belonging to another source), `sign_in_timeout`,
  `sign_in_wrong_step` (409), `sign_in_poll_too_soon` (429).
- `POST /sources/{id}/sign-in/start` and `/sign-in/finish` remain for pasted-link flows: they run
  the same attempt mechanism in one call each.
- `POST /sources/{id}/sync`.

**Other routes**

- `GET /carriers` lists the plug-ins with their capabilities, config schemas, the default
  sign-in type (`sign_in`) and every flow (`sign_in_flows`: id, label, type, kinds, conditional).
- `GET /calendar?from&to` returns the same entries the UI calendar and the ICS feed use.
- `GET /orders` and `GET /orders/{id}`.
- `/tokens` and `/settings`.
- `/health/live`, `/health/ready`, and `/diagnostics`, which is redacted.

#### Push

`GET /api/v1/events` is the SSE stream.

- Each message has `id: <outbox seq>`, `event: <type>` and `data: <JSON>`.
- `Last-Event-ID` replays up to 7 days of events.
- A heartbeat is sent every 25 s.

#### Event types

| Type | Fires when |
|---|---|
| `parcel.registered` | A new incoming parcel appears |
| `parcel.status_changed` | The canonical status changes, except a change *to* delivered |
| `parcel.delivered` | The only event for the hop to delivered |
| `parcel.delivery_time_changed` | `planned_from` or `planned_to` changes |
| `parcel.outgoing_registered`, `parcel.outgoing_delivered` | The outgoing pair |
| `parcel.live_updated` | A live session starts or ends, its state changes, or `stops_away` changes. Never for a position change alone |
| `parcel.removed` | An active parcel has been gone, undelivered, for 6 h. Nothing is judged while one of its sources is failing |
| `source.state_changed` | A source changes state, including "needs sign-in" |
| `vocab.unknown` | An unmapped status value is seen for the first time |

The payload is the normalised parcel without `raw`, with `live` stripped of coordinates and the
trail, plus `old_*` and `new_*` for whatever changed.

#### Parcel shape

The suite contract keys: `carrier`, `barcode`, `sender`, `receiver`, `status`, `raw_status`,
`delivered`, `delivered_at`, `planned_from`, `planned_to`, `pickup`, `pickup_point`, `history`
and `url`. On top of those:

- `id`, `items`, `live`, `location`, `order`, `sources`, `manual_status`, `label` and
  `updated_at`;
- `lookup: {state, since, checked_at}`: what a tracking source last heard from the carrier about
  the code. `pending` (never answered, or no tracking source follows it), `found`, or
  `not_found` (asked, and the carrier did not return it). `since` is when the state began,
  `checked_at` the last time the carrier was asked. Not found fires no event;
- the runner logs at info level how many codes it asked about and how many were found, never
  the codes;
- `raw` only on request, with `?include=raw`.

#### ICS feed

`/ical/{token}.ics`.

- The token is a read-only, revocable secret, because calendar apps can't send headers.
- Each event's UID is `<parcel-id>@open-parcels`.
- Windows that cover whole days become all-day events. When a real time window arrives, the same
  UID narrows to it.

#### Image proxy

`/img/{id}.{sig}`.

- The id is HMAC-signed, so the proxy is not open to arbitrary URLs.
- It fetches only from hosts the carrier allow-lists, with a size cap, and refuses redirects to
  private addresses.
- Images are cached on disk.
- Delivery photos behind expiring links are fetched at once and kept.

### 2.7 Security

**Web UI sign-in**

- An owner password, set on a one-time setup page at first start. There is no default password.
- A session cookie (HttpOnly, SameSite=Lax, Secure over HTTPS) plus a CSRF token.

**API clients** use Bearer API tokens with the scopes `read`, `write` and `admin`.

**Under Home Assistant ingress**

- Requests are accepted only from `172.30.32.2`, on a separate listener.
- They count as the owner, because HA has already authenticated the user.

**Secrets at rest**

- Encrypted with AES-256-GCM, with the row id as associated data.
- The key comes from `OPENPARCELS_SECRET_KEY`, or else from `/data/secret.key`, which is created
  with mode 0600.
- A decryption failure is a hard error that marks the source "needs sign-in". There is never a
  silent random key.

**Logs and diagnostics**

- pino `redact` covers tokens, cookies, Authorization headers and credentials.
- A value scrubber masks emails, tracking numbers (except a short prefix) and coordinates.
- Diagnostics use the same scrubber.

**Stored credentials**

- Amazon uses device registration, so we never see the password.
- DHL DE uses OIDC with a pasted link.
- Vinted Go (emailed link), Airmee (SMS code), USPS Informed Delivery (password plus USPS's own
  verification) and Posti (bank or mobile ID) keep only the tokens the sign-in yields. Posti
  additionally keeps the private key of the trusted device it registers on the account.
- Hermes, DHL NL and IMAP need stored credentials, and those are encrypted.
- An unfinished interactive sign-in keeps its state encrypted in `sign_in_attempts` until it
  finishes or expires.

**CORS** is off by default. Enabling it requires an explicit allow-list.

**Container**

- Runs as a non-root user (uid 1000).
- The root file system is read-only. `/data` is the only writable volume, plus a tmpfs `/tmp`.
- `tini` as init, plus a `HEALTHCHECK`.

### 2.8 Packaging and operations

**One image**, built for `linux/amd64` and `linux/arm64`. arm64 is needed because the Home
Assistant Pi is aarch64, and HA apps support only amd64 and aarch64.

- It is published to Docker Hub as `bluscream1/open-parcels` and to GHCR as
  `ghcr.io/bluscream/open-parcels`.
- It listens on port 3000, unchanged, so the existing Unraid mapping 4000→3000 keeps working.

**Builds run locally** with `docker buildx` and QEMU, because workflows don't run under this
account. A `workflow_dispatch` workflow is kept for anyone who forks the repo. Its automatic
triggers are commented out, with the reason written above them.

**Unraid:** the template is updated with the new variables, the healthcheck and `/data`.

**Home Assistant app:**

- `image:` points at the same image;
- ingress is on, with `discovery: [open_parcels]`;
- `backup_exclude` covers the image cache;
- the app's options map to environment variables.

**Visibility:** JSON logs, a Status page in the UI, and downloadable diagnostics with redaction
applied.

### 2.9 First carriers

| Carrier | Source kinds | Notes |
|---|---|---|
| Amazon (shop) | account (device registration), live, items, hand-off | Several storefronts; arrival parsing driven by locale tables (en/de first) |
| DHL | tracking (several backends, merged), DE account (OIDC with pasted link) | The official keyed API is optional |
| DPD | DE public tracking page, myDPD DE account | The public page can be switched off per source, because of its `robots.txt` |
| Hermes | tracking, account | Public forecast window for account parcels, with a concurrency cap |
| Mail | IMAP IDLE | Rules from `open-parcels-rules`, seeded from the existing rules and the German `.eml` corpus |

**Coverage goal** (owner's decision, 2026-11-18): open-parcels supports at least every provider and
courier the Home Assistant suite covers, and more where it is cheap. After the suite, the
universal-lookup service's carriers are the next source to mine.

## 3. Migrating the existing data

The deployed `/mnt/user/appdata/openparcels/data.db` uses the UUID schema. It holds 409 orders,
69 parcels, 296 events, 4 credentials and 5 settings.

1. **Back up** `/mnt/user/appdata/openparcels` before anything else.
2. **Run the importer as a dry run.** `openparcels import-legacy <path> --dry-run` reads both
   old schema variants and reports what it would do. Without `--dry-run` it writes everything in
   one transaction:
   - orders become `orders`;
   - parcels become `parcels`, with courier names normalised to plug-in ids and old statuses
     mapped (`arriving` → `out_for_delivery`, and so on);
   - `is_manual_status` becomes `manual_status`;
   - events become `parcel_events`. Courier-position rows from the old live scraper are dropped;
   - an empty or generic courier (`china`, `17track`, `unknown`) is resolved from the code by the
     shared tracking-number detection, then from the old order's shop (AliExpress → Cainiao,
     Amazon → Amazon); China Post codes go to Cainiao, which tracks them. `unknown` remains only
     when nothing identifies the carrier. Running the importer again corrects a placeholder
     carrier left by an earlier run;
   - undelivered, unarchived parcels are linked to their carrier's tracking source (created if
     missing), as `POST /parcels` does. Every server start repeats this for any active parcel no
     carrier source follows, so databases imported earlier are covered;
   - IMAP credentials are decrypted with the old key and re-encrypted as a mail source. The usual
     field names and nestings are read (host/server, port, secure/tls/ssl, user/username/email,
     password/pass, folders), with the host and port also taken from old `imap_*` settings.
     Amazon passwords and TOTP secrets are **not** imported, because Amazon is signed in again by
     device registration; AliExpress likewise. The report lists every skipped credential with
     the reason.
3. **Keep the old file** read-only as `data.legacy.db`.
4. **Verify against a copy.** Run the import on a copy, compare the counts, and only then replace
   the container.

## 4. Roadmap

Every phase lands as reviewable commits, with the gate green at each one.

| Phase | Delivers |
|---|---|
| **1. Foundation** | npm workspaces; the quality gate (tsc, eslint strict-type-checked with size limits, vitest, a pre-commit hook); config; database and migrations; auth (setup, sessions, tokens); parcel model and API skeleton; outbox and SSE; Docker image |
| **2. Engine** | Plug-in contract; reconciler and event rules; scheduler with fake-timer integration tests; rate limits and backoff; a fake carrier for tests |
| **3. `open-parcels-rules`** | Rename and merge; schemas, engine, test vectors; jkeen import plus the EU overlay; status tables for the first carriers; en/de locale tables; the existing mail rules converted |
| **4. Carriers, wave 1** | Amazon (account, items, arrival parsing, hand-off, live), DHL, DPD, Hermes, each with recorded made-up fixtures |
| **5. Mail** | IMAP IDLE watcher, rule engine integration, `.eml` fixture tests |
| **6. Web UI** | Parcel list, detail view, map with live couriers, Calendar tab, carrier/account setup, mail setup, tokens, Status page |
| **7. Map, calendar and images** | Place resolver (Nominatim, opt-in, 1 request/s, cached), ICS feed, image proxy, retention jobs |
| **8. Migrate and deploy** | Legacy importer; NAS backup; replace the container; update the template; end-to-end check through the logs and visually in LibreWolf |
| **9. HA app** | App repository, ingress, discovery, multi-arch publish to Docker Hub and GHCR |
| *Later* | Thin HA integration, and only then changes on the running Home Assistant; MQTT; more carriers |

## 5. Questions settled at acceptance

1. **Backend language:** TypeScript, the owner's preference.
2. **Users:** one per container.
3. **Shared knowledge repo:** `open-parcels-rules`, consolidating `email-parser-rules` and
   `mail-parser-ts`.
4. **DPD Germany's public tracking page:** used, at the normal polling rate.
5. **Image registries:** Docker Hub and GHCR.
6. **Licensing:** left undecided until publication.
7. **Git history:** the scrubbed history is kept. The pre-rewrite code is on branch `legacy-ts`
   and tag `v1-final`.
