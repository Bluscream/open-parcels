# 0001 — Rebuild open-parcels as the single parcel-tracking backend

- **Status:** proposed (waiting for the owner's approval)
- **Date:** 2026-11-18

## 1. Context

open-parcels was dormant from September 2026. Meanwhile the parcel logic that actually works
(carrier sign-ins, status vocabularies, adaptive polling, live courier tracking, calendars, the
map) was built as Home Assistant integrations. The goal now is to make open-parcels the one place
where tracking happens: a Docker container that signs in to carriers, polls, reads mail, follows
couriers live, resolves places, stores history and publishes events. A later Home Assistant
integration only displays what open-parcels publishes. It must be good enough for many
installations (Docker, Unraid, and a Home Assistant app on a Raspberry Pi), not just one.

### What the audit found

**The existing TypeScript code** is about 4.8k lines of backend, 6.7k of React frontend and
2.9k of scripts.

- **No carrier logic of its own.** Every lookup went to a separate service, universal-lookup.
- **Nothing runs by itself.** There is no scheduler: IMAP polling and parcel refresh were never
  triggered automatically.
- **Security problems:**
  - GET requests need no token, and `/admin/db-backup` returns the whole database to anyone.
  - The WebSocket streams every log line without authentication.
  - Mail rules are downloaded and executed with `node:vm`.
  - The encryption key silently falls back to a random one.
- **Database:** the schema is pushed at every boot, with no versioned migrations.
- **Container:** the image cannot run its own Playwright code, runs as root and has no
  healthcheck.
- **Worth keeping:** the React map pieces (`mapIcons`, `AnimatedRoute`, `SharedMap`,
  `SplitContainer`), `DataTable`, and the knowledge of Amazon's live endpoints.

**The Home Assistant suite** has 87 carrier repos written in Python on top of aiohttp. Its
carrier transports take an injected HTTP session and do not import Home Assistant, so they are
separable. Carrier logic is 25–60 % of each repo. Each repo carries its own copy of the parcel
model; there is no shared package.

**Newer techniques** are in the fork and PR worktrees: live courier tracking, the
`parcel_removed` grace period, the calendar narrowing, place lookup, hand-off and the order-line
parsers. The live-tracking path has been proven on a real delivery, a Home Assistant session on
2026-11-18. It read every 30 s, the stop count went down and back up again, and the events
carried no coordinates.

**Prior art.** Nothing covers the whole job.

- *Dude, Where's My Package* has the closest architecture (Docker, API, a Home Assistant app and
  integration), but it is Dutch-focused and has no Hermes, IMAP, map or ICS.
- *Paket Tracker* has the best German mail rules and an anonymised `.eml` corpus, but it runs
  only inside Home Assistant.
- *jkeen/tracking_number_data* is the de-facto tracking-number dataset, but it has no Hermes,
  GLS or PostNL and no DHL Paket DE.

### Requirements this decision has to meet

- **Carriers as plug-ins**, one per source kind: account, tracking code, shop, mail.
- **One normalised parcel shape:** the suite contract plus `items`, `live` and `location`.
- **Adaptive polling** with per-carrier and per-account rate limits and backoff.
- **Live courier tracking that feels instant:** the delivered event fires within about a minute.
- **API:** versioned REST with OpenAPI, a push channel, an ICS feed and an image proxy.
- **Accounts and secrets:** several users, API tokens, credentials and sessions encrypted at
  rest, no secrets in logs, redacted diagnostics.
- **Packaging:** one image for amd64 and aarch64. The same image also runs as a Home Assistant
  app.
- **Reusable knowledge:** regexes, parsing rules, status tables and locales live in a separate,
  shared repository.
- **Quality:** strict typing and linting, recorded made-up fixtures for every carrier, and
  integration tests for the scheduler and the event rules.

## 2. Decision

### 2.1 Rewrite the backend in Python; keep and rebuild the React frontend in TypeScript

**Backend: Python 3.14.** The reasons:

1. **The carrier logic is the product, and it exists in Python.** It is the bulk of the work and
   the part that changes most often. In Python each carrier is re-implemented quickly against
   behaviour that is already proven. In TypeScript every one of them would be a hand port, first
   for the initial carriers and again for every later one.
2. **Tooling against carrier anti-bot measures is most mature in Python.** `curl_cffi` is a
   drop-in client that can present a browser's TLS fingerprint, which some carrier and shop
   endpoints check. The Node alternatives are younger.
3. **Runtime validation fits messy carrier JSON.** pydantic v2 is the strongest option in any of
   the candidate stacks for validating payloads that change shape without notice.
4. **Contributors are already in Python.** The people who write and fix carriers today work in
   it, and the shared knowledge repo can still be used by any language.
5. **Footprint is comparable.** Measured on Windows, a FastAPI app idles at about 90 MB; Fastify
   with Drizzle idled at about 207 MB, an anomaly still to check on Linux. Neither matters next
   to Chromium, which we avoid by default (2.6).

**Frontend: React + Vite + TypeScript.** It stays: it is good code, it is what the owner liked,
and it talks to the backend only through a generated OpenAPI client. Strict TypeScript and
type-aware typescript-eslint, on TypeScript 6 until typescript-eslint supports TypeScript 7.

**Not chosen:**

- **Staying on the TypeScript backend.** Almost nothing of it survives a fix-up: there are no
  carriers, the security model has to be redone, and there is no scheduler. Keeping it buys
  little, and it would mean hand-porting every carrier.
- **Go or Rust.** Smaller images, but Playwright drags Node in anyway. Carriers would be ported a
  second time, Go's IMAP library is still beta, and the workload is I/O-bound at a few requests
  per second.

**Accepted risks and how they are handled:**

- **Python's static typing is weaker than TypeScript's.** `mypy --strict` runs as a gate, pydantic
  models sit at every boundary, there is no bare `Any`, and every `type: ignore` names its code
  and gives a reason.
- **Some dependencies need native aarch64 wheels.** Use a glibc slim base, never Alpine, pin the
  Python minor version, and build arm64 in the same local buildx run.
- **Some popular libraries are stalled.** Avoid httpx/respx, APScheduler 4 (alpha) and SQLModel
  (0.0.x).

### 2.2 Main libraries

| Concern | Choice | Why |
|---|---|---|
| Web framework | FastAPI + uvicorn | OpenAPI built from pydantic models; largest community |
| Models / validation | pydantic v2, pydantic-settings | Runtime validation at every boundary |
| Database | SQLite (WAL) via SQLAlchemy 2.1 async + aiosqlite | One file in `/data`; the schema can move to Postgres later |
| Migrations | Alembic | Versioned migrations, never a schema push |
| HTTP to carriers | aiohttp; `curl_cffi` only for carriers that need a browser fingerprint | Per-carrier choice, recorded in the plug-in |
| HTML parsing | selectolax (lxml as fallback) | Fast, small |
| Scheduler | Our own asyncio scheduler: a heap of next-run times, token buckets, backoff | The polling rules don't fit cron; it is fully testable with a fake clock |
| IMAP | aioimaplib with IDLE | Push instead of polling; reconnect with backoff |
| ICS | icalendar | Mature |
| Push | Server-Sent Events | One-way is all clients need; `Last-Event-ID` replay is built in; works through HA ingress |
| MQTT | aiomqtt, optional, later phase | Only for users without the integration |
| Secrets | `cryptography` AES-256-GCM | Authenticated encryption, the row id bound as associated data |
| Passwords | argon2-cffi (argon2id) | Current recommendation |
| Logging | structlog, JSON output | A redaction processor runs on every log line |
| Tests | pytest, pytest-asyncio, aioresponses, time-machine, hypothesis | Recorded fixtures at the HTTP boundary, plus a fake clock |
| Frontend | React 19, Vite, TanStack Router + Query, orval-generated client, Leaflet/react-leaflet, FullCalendar (month/week/day/list/multi-month), TanStack Table | Reuses the existing map pieces and table |
| Browser (only if a carrier needs it) | Playwright Chromium in a separate optional image variant | Most installs never download a browser |

### 2.3 Repositories

| Repo | Contents |
|---|---|
| `open-parcels` (this repo) | Server (`src/openparcels/`), carrier plug-ins (`src/openparcels/carriers/`), web UI (`web/`), Dockerfile, Unraid template |
| **`parcel-knowledge`** (new; name to confirm) | Language-neutral data: tracking-number patterns (jkeen's dataset as a pinned upstream plus our EU overlay in the same schema), carrier status tables mapped to the canonical status list, locale tables for delivery dates and windows, mail rules, place-extraction patterns and tracking-URL templates. Includes a JSON Schema, test vectors per rule, and thin Python and TypeScript loaders checked against the same vectors. The regex subset is portable: no lookaround and no backreferences |
| `open-parcels-ha-apps` (new, later) | The Home Assistant app repository: `repository.yaml` plus one app folder that points at the same image. It has to be separate, because the Marketplace refuses repositories that contain apps |
| `open-parcels-ha` (new, later; not part of this task) | The thin integration, installed from the Marketplace |

The carrier plug-ins stay inside `open-parcels` at first, behind a strict boundary: no imports
from the app, only the plug-in API. Once that API settles they can split out as a
`parcel-carriers` package that the Home Assistant suite could also use.

The old TypeScript code moves to a `legacy-ts` branch with a `v1-final` tag. Nothing is deleted.

### 2.4 Architecture

```
               ┌──────────────── open-parcels container ────────────────┐
  Web UI ─────►│ FastAPI  /api/v1 (REST, OpenAPI)   /api/v1/events (SSE)│◄── HA integration
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

- **Plug-in contract.** Each carrier is a module that declares:
  - metadata: id, name, countries, capabilities, which source kinds it offers;
  - a pydantic config schema, which the UI renders as a form;
  - its sign-in flow type: none, credentials, a pasted redirect link, an API key, or OIDC;
  - its rate-limit policy;
  - async methods returning `ParcelSnapshot` objects.

  Plug-ins never touch the database or send events; they only return snapshots. Third-party
  carriers can be added as Python entry points.
- **The reconciler is the only writer of parcels.** It merges snapshots from every source. For
  DHL that means the newest scan wins and the other backends fill gaps. It applies the suite's
  status rule (map → newest mapped history entry → `unknown`, with one warning per new value),
  handles hand-off (an Amazon parcel carried by DHL becomes one parcel with two sources), and
  derives events by comparing old and new state in the same transaction that writes the outbox
  row.
- **The scheduler implements the suite's polling rules:**
  - a quiet window from 00:00 to 06:00 with catch-up anchors;
  - a fast tier of 15 minutes for parcels out for delivery within an hour of `planned_from`;
  - a slow tier of 45 minutes for everything else;
  - a stagger per install and source;
  - on HTTP 429, honour `Retry-After`, otherwise back off 60 s × 2ⁿ up to 1 hour;
  - stop polling account-less sources when nothing is active.

  On top of that it adds a token bucket per carrier host and at most one request at a time per
  account. A network error never triggers a new sign-in; only an explicit rejection does, once,
  and then the source is marked "needs sign-in".
- **Live tracker.** It polls every 30 s while a map session is open and probes every 5 minutes for
  out-for-delivery parcels without a map. After 3 failed passes it stops until the next full
  poll, honours `Retry-After`, and never signs in again because of a network error. When a
  session reports delivered or ended, the parcel is refreshed immediately. Positions are kept in
  memory and in the parcel's current `live` value only; they are never written to history.
- **Mail watcher.** It uses IMAP IDLE per mailbox (the configured folders). Each new message goes
  through:
  1. schema.org `ParcelDelivery` markup, if present;
  2. shop and carrier rules from `parcel-knowledge`;
  3. tracking-number detection constrained by sender and context.

  Messages are deduplicated by Message-ID. A message is never marked as read unless the user opts
  in.
- **Browser isolation.** No first-wave carrier needs a browser: Amazon signs in through device
  registration with a pasted link, and DHL DE through OIDC with a pasted link. If one ever needs
  it, it runs in the `-browser` image variant as a separate process with one browser at a time,
  a hard timeout and a memory cap.

### 2.5 Data model (SQLite, Alembic)

| Table | Key fields | Notes |
|---|---|---|
| `users` | id, username, password_hash (argon2id), role (`admin` / `user`), ha_user_id | `ha_user_id` maps HA ingress users |
| `api_tokens` | id, user_id, name, hash (SHA-256), scopes, last_used_at, expires_at | Shown once at creation |
| `sources` | id, user_id, plugin, kind (account / tracking / shop / mail), label, config (JSON), secret_blob (AES-GCM), session_blob (AES-GCM), state (ok / needs_sign_in / error / disabled), backoff fields, last_ok_at | One per sign-in or mailbox |
| `parcels` | id (UUID), user_id, carrier, barcode, direction, status, raw_status, delivered, delivered_at, planned_from, planned_to, pickup, pickup_point, url, sender, receiver, weight, dimensions, label, order_id, manual_status, manual_until, first_seen_at, last_seen_at, removed_at, archived_at | Unique on (user, carrier, barcode). A manual override is never overwritten |
| `parcel_sources` | parcel_id, source_id, external_ref, role (primary / handoff / mail), last_seen_at | Hand-off and deduplication live here |
| `parcel_events` | id, parcel_id, source_id, at, status, raw_status, location_text, fingerprint (unique) | The history. No coordinates |
| `parcel_raw` | parcel_id, source_id, fetched_at, payload (JSON) | Latest payload per source, kept separately. Codes that open or sign in to something are stripped |
| `items` | id, parcel_id, title, image_ref, url, external_id (e.g. ASIN), quantity, price, currency | Images go through the image proxy |
| `orders` | id, user_id, shop, order_number, placed_at, status | |
| `live_state` | parcel_id, state, stops_away, message, position_at, updated_at | No coordinates are stored; the latest position lives in memory |
| `places` | key (normalised text), lat, lng, precision, missed_at | Hits and misses are cached; misses are retried after 7 days |
| `outbox` | seq (monotonic), user_id, type, parcel_id, payload (JSON), created_at | Feeds SSE replay and later webhooks/MQTT |
| `unknown_vocab` | plugin, kind, key, first_seen_at, count | Drives the one-time "please report" warning. Keys only, never values |
| `settings`, `image_cache` | | |

**Retention:**

- delivered parcels are archived after 30 days and deleted after 365 days (both configurable);
- `parcel_raw` is dropped 30 days after delivery;
- the outbox is kept for 7 days;
- the image cache is capped at 200 MB.

### 2.6 API and event contract

**REST, under `/api/v1`, OpenAPI at `/api/v1/openapi.json`:**

- `GET /parcels` (filters: status, carrier, active, delivered within, q), `GET /parcels/{id}` (adds
  history, items, sources, live and location), `POST /parcels` (track a code; carrier is
  detected or given), `PATCH /parcels/{id}` (label, manual status, archive), `DELETE`.
- `POST /parcels/{id}/refresh`.
- `GET/POST/PATCH/DELETE /sources`, `POST /sources/{id}/sign-in/start`,
  `POST /sources/{id}/sign-in/finish` (for pasted links and codes), `POST /sources/{id}/sync`.
- `GET /carriers` (plug-ins, their capabilities, config schemas and sign-in flows).
- `GET /calendar?from&to` (the events the UI calendar and the ICS feed share).
- `GET /orders`, `GET /orders/{id}`.
- `GET /me`, `/users`, `/tokens`, `/settings`.
- `GET /health/live`, `/health/ready`, `/diagnostics` (admin only, redacted).

**Push:** `GET /api/v1/events` (SSE).

- Each message is `id: <outbox seq>`, `event: <type>` and `data: <JSON>`.
- `Last-Event-ID` replays up to 7 days of events.
- A heartbeat is sent every 25 s.

**Event types:**

| Type | Fires when |
|---|---|
| `parcel.registered` | First time a parcel is seen (incoming) |
| `parcel.status_changed` | The canonical status changed, except a change *to* delivered |
| `parcel.delivered` | The only event for the hop to delivered |
| `parcel.delivery_time_changed` | `planned_from` or `planned_to` changed |
| `parcel.outgoing_registered` / `parcel.outgoing_delivered` | The outgoing pair |
| `parcel.live_updated` | A live session starts or ends, its state changes, or `stops_away` changes. Never on a position change alone |
| `parcel.removed` | An active parcel has been missing and not delivered for 6 h. Nothing is judged while one of its sources is failing |
| `source.state_changed` | Includes "needs sign-in" |
| `vocab.unknown` | First time an unmapped status is seen |

**Payload:** the normalised parcel without `raw`, with `live` stripped of coordinates and trail,
plus `old_*` and `new_*` fields for the changed values.

**Parcel shape:** the suite contract keys (`carrier`, `barcode`, `sender`, `receiver`, `status`,
`raw_status`, `delivered`, `delivered_at`, `planned_from`, `planned_to`, `pickup`,
`pickup_point`, `history`, `url`) plus `id`, `items`, `live`, `location`, `order`, `sources`,
`manual_status`, `label` and `updated_at`. `raw` is only returned by
`GET /parcels/{id}?include=raw` to admins.

**ICS:** `/ical/{token}.ics`.

- The token is a per-user, read-only, revocable secret, because calendar apps cannot send
  headers.
- Event UID is `<parcel-id>@open-parcels`.
- Whole-day windows become all-day events. When a real time window arrives, the same UID narrows
  to it.

**Image proxy:** `/img/{id}.{sig}`.

- The id is HMAC-signed by the server, so it is not an open proxy.
- Fetches only from hosts the carrier allow-lists, with a size cap and no redirects to private
  addresses.
- Images are cached on disk. Delivery photos behind expiring links are fetched at once and kept
  only for their owner.

### 2.7 Security

- **Sign-in to the web UI:** a session cookie (HttpOnly, SameSite=Lax, Secure when served over
  HTTPS) plus a CSRF token.
- **API clients:** Bearer API tokens with scopes `read`, `write` and `admin`.
- **First start:** creates the admin through a one-time setup page. There is no default
  password.
- **Under HA ingress:** requests are accepted only from `172.30.32.2`, and `X-Remote-User-Id` is
  mapped to a user. A request without that header is unauthenticated, never a default user.
  Ingress runs on its own listener.
- **Secrets at rest:** AES-256-GCM.
  - The key comes from `OPENPARCELS_SECRET_KEY` or, if that is unset, from `/data/secret.key`
    (created with mode 0600 and logged once as created).
  - A decryption failure is a hard error that marks the source "needs sign-in". It never falls
    back to a random key silently.
- **Logs:** a structlog processor redacts tokens, cookies, Authorization headers, emails,
  tracking numbers (except a short prefix) and coordinates. Diagnostics use the same redaction.
- **No passwords where avoidable:** Amazon uses device registration (we never see the password)
  and DHL DE uses OIDC with a pasted link. Hermes and IMAP need stored credentials, which are
  encrypted.
- **CORS:** off by default; an explicit allow-list when enabled.
- **Container:**
  - runs as a non-root user (uid 1000) with a read-only root file system;
  - `/data` is the only writable volume, plus a tmpfs `/tmp`;
  - `tini` as init and a `HEALTHCHECK`;
  - no shell scripts at runtime other than the entrypoint.

### 2.8 Packaging and operations

- **One image:** `bluscream1/open-parcels`, built for `linux/amd64` and `linux/arm64`. arm64 is
  needed, because HA apps support only amd64 and aarch64 and the Pi is aarch64.
  - Base image: `python:3.14-slim`. The web UI is built in a Node stage and served as static
    files.
  - Port 3000, unchanged, so the existing Unraid template and the NAS mapping 4000→3000 keep
    working.
- **Building:** done locally with `docker buildx` and QEMU, because workflows do not run under
  this account. A `workflow_dispatch` workflow is kept for anyone who forks the repo, with its
  automatic triggers commented out and the reason written above them.
- **Unraid:** the template is updated with the new variables, the healthcheck and the `/data`
  path.
- **Home Assistant app:**
  - `image:` points at the same multi-arch image;
  - `ingress: true`, `discovery: [open_parcels]`, `backup_exclude` for the image cache;
  - its options map to environment variables.
- **Visibility:** structured JSON logs, a Status page in the UI (sources, last runs, backoff,
  queue, unknown statuses, version), and redacted diagnostics for download.

### 2.9 First carriers

| Carrier | Source kinds | Notes |
|---|---|---|
| Amazon (shop) | account (device registration), live, items, hand-off | Several storefronts; arrival parsing driven by the locale tables (en/de first) |
| DHL | tracking (several backends, merged), DE account (OIDC with pasted link) | The official keyed API is optional |
| DPD | DE public tracking page, myDPD DE account | The public page's `robots.txt` disallows the redirect URL; see open question 4 |
| Hermes | tracking code, account | Public forecast window for account parcels, with a cap on concurrent lookups |
| Mail | IMAP IDLE | Rules from `parcel-knowledge`, seeded from the German `.eml` corpus |

GLS, PostNL, UPS and the others follow carrier by carrier through the same plug-in contract.

## 3. Migrating the existing data

The deployed `/mnt/user/appdata/openparcels/data.db` has the UUID schema with 409 orders,
69 parcels, 296 events, 4 credentials and 5 settings.

1. **Back up** `/mnt/user/appdata/openparcels`, all of it, before anything else.
2. **Import with a dry run first.** `openparcels import-legacy <path> --dry-run` reads the old
   schema (both the UUID and the older integer variant) and reports what it would do. Without
   `--dry-run` it writes inside a single transaction.
   - orders → `orders`;
   - parcels → `parcels`, owned by the admin. Courier names are normalised to plug-in ids, and
     old statuses are mapped (`arriving` → `out_for_delivery`, and so on). `is_manual_status`
     becomes `manual_status`;
   - events → `parcel_events`. Courier-position rows from the old live scraper are dropped,
     because positions are never history;
   - IMAP credentials are decrypted with the old key and re-encrypted. Amazon passwords and TOTP
     secrets are **not** imported; Amazon is signed in again through device registration;
   - settings are mapped where an equivalent exists.
3. **Keep the old file.** It stays read-only as `data.legacy.db`. The new database is
   `openparcels.db`.
4. **Verify against a copy.** The import runs against a copy, the counts are compared, and only
   then is the container replaced.

## 4. Roadmap (each phase lands as reviewable commits with the gate green)

| Phase | Delivers |
|---|---|
| **1. Foundation** | `legacy-ts` branch; Python project; quality gate (ruff, mypy, pytest, size-limit tests, pre-commit); config; database and Alembic baseline; auth (setup, sessions, tokens); parcel model and API skeleton; outbox and SSE; Docker image (non-root, healthcheck) |
| **2. Engine** | Plug-in contract; reconciler and event rules; scheduler with fake-clock integration tests; rate limits and backoff; a fake carrier plug-in used only in tests |
| **3. `parcel-knowledge`** | Schema, loaders (Python and TypeScript), test vectors, jkeen import plus EU overlay (DHL Paket, DPD, Hermes, GLS, Amazon); status tables for the first carriers; en/de locale tables |
| **4. Carriers, wave 1** | Amazon (account, items, arrival parsing, hand-off, live), DHL, DPD, Hermes. Each comes with recorded made-up fixtures |
| **5. Mail** | IMAP IDLE watcher, rule engine, `.eml` fixture tests |
| **6. Web UI** | Parcel list, detail, map with live couriers, Calendar tab, carrier and account setup, mail setup, users and tokens, Status page |
| **7. Map, calendar and images** | Place resolver (Nominatim, opt-in, 1 request/s, hits and misses cached), ICS feed, image proxy, retention jobs |
| **8. Migrate and deploy** | Legacy importer; NAS backup; replace the container; update the template; end-to-end test against the logs and visually in LibreWolf |
| **9. HA app** | App repository, ingress, discovery, multi-arch publish |
| *Later* | Thin HA integration; then, and only then, changes on the running Home Assistant; MQTT; more carriers |

## 5. Open questions for the owner

1. **Python backend.** Is the rewrite approved?
2. **Several users.** Separate users, each with their own carrier accounts and parcels, plus an
   admin. Or is a single household user enough?
3. **Name of the knowledge repo.** `parcel-knowledge` or another name.
4. **DPD Germany's public tracking page.** Its `robots.txt` disallows `/redirect.aspx`. Use it
   anyway, for the user's own parcels at the normal polling rate?
5. **Image registry.** Keep Docker Hub `bluscream1/open-parcels`, add GHCR as well, or switch to
   GHCR?
