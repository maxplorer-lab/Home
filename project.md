# Home — project notes

**Home** is the family super app: one Cloudflare Worker, one domain, one login,
three modules. It merges the formerly standalone **Sompitra**, **W.A.Y** and
**Laoka** Workers into a single WeChat-style engine where every module keeps
its own database, its own frontend and its own colour palette — but signs in
through one shared door.

## The one-paragraph architecture

A single Worker (`src/index.tsx`) mounts three modules under path prefixes and
serves the Sompitra finance suite at the root. Identity lives in a **separate
central database** (`home-db`) that only knows people, passwords and sessions.
When a person logs in, the identity engine (`src/identity.ts`) provisions them
into each module's own database (first time only) and mints each module's
**native** session cookie — Sompitra, W.A.Y and Laoka never learn that a
"super app" exists; they just see their own sessions. If a module cookie is
ever missing or stale, the worker transparently re-mints it on the next 401
("auto-repair") so one login keeps working everywhere.

## Modules

| Module | What it is | URL | Database | Session cookie |
| --- | --- | --- | --- | --- |
| **Sompitra** | Finance suite: budget, Kiné, debts & credits, sales & stock (Hono JSX SSR) | `/` | `DB` → `sompitra-db` | `session` (D1-backed) |
| **W.A.Y** | GPS tracking, geofences, μlogger ingest (Durable Object + cron) | `/way/` | `WAY_DB` → `way-db` | `way_user_session` (stateless HMAC) |
| **Laoka** | Weekly meal planner with shared shopping list (vanilla SPA) | `/laoka/` | `LAOKA_DB` → `laoka` | `laoka_session` (D1-backed) |
| **Home** | Central identity + admin console | `/login`, `/admin` | `HOME_DB` → `home-db` | `home_session` (D1-backed) |

App-global endpoints: `/ws` (W.A.Y FleetDO socket — also powers Chat),
`/laoka-ws` (Laoka Lobby socket), `/ulogger*` (W.A.Y phone ingest).

## The one-app UI (WeChat model)

One chrome for everything: a shared header (brand + module + user + dark-mode
toggle) and one bottom tab bar — **Home · Sompitra · Chat · Laoka · WAY ·
You** — defined **once** in `src/views/app-chrome.tsx` (`HomeHeader`,
`HomeTabBar`, `CHROME_CSS`) and imported by both hosts: `src/views/layout.tsx`
(Sompitra pages) and `src/views/shell.tsx` (the WAY / Laoka / Chat tabs).
Each module keeps its own palette and its own internal controls, but never
its own brand bar or its own navigation bar — those belong to Home.
Tab icons are the real assets (`/icon-64.png`, `/way/icon-512.png`,
`/laoka/icon.svg`) plus inline SVG for the shell-native tabs — never emoji,
which render as blurry colour glyphs and cannot inherit the active tint.

* **Sompitra pages and Chat** render directly in the shell document. Chat
  passes `fullBleed` so the message list stretches between header and tab bar
  (the body is a `min-h-full flex flex-col`; the tab bar is `sticky bottom-0`,
  so it participates in that flex column).
* **WAY and Laoka** run **chromeless inside an iframe** of the tab's shell
  page (`/way/` and `/laoka/` are Worker-rendered, session-gated pages that
  embed `/way/index.html` / `/laoka/index.html` — both in `run_worker_first`).
  Each module document detects the frame (`window.self !== window.top`) in a
  head script and hides its own chrome **before first paint**: WAY hides only
  its brand and re-floats its view pills (Map / Trips / Chat / Settings) over
  the map — they are the module's only internal navigation; Laoka keeps its
  week selector and tab pills. Visited standalone the modules keep their
  complete original UI.
* **There is exactly one chat — and it is WAY's own.** The Chat tab (`/chat`)
  is a ModuleShell embedding `/chat/index.html` — **its own document**, the
  family chat and nothing else. The code inside it IS WAY's original chat
  engine (message bubbles, replies, reactions, system messages), moved out
  of WAY's dashboard rather than re-written: same `/ws` socket, same
  FleetDO, so history/replies/reactions stay one stream. WAY no longer has
  any chat — no pill, no modal, no CSS, no JS, no `?view=chat` mode — and
  Sompitra's old WebSocket chat re-implementation was deleted earlier
  (`src/routes/chat.tsx`, `src/lib/way.ts`). There is exactly one chat in
  the product and it has one home.
* Sompitra (budget/kine/debts/sales) is one tab with its own desktop sub-nav;
  `/settings` is the You tab; `/admin` stays a Sompitra-style page.

## Identity engine (`src/identity.ts`)

* **One login per person**: username + password, stored only in `home-db`.
* **Passwords** are hashed exactly like Laoka's scheme: HMAC with the
  `AUTH_PEPPER` secret, then PBKDF2-SHA-256 (base64 salt/hash, per-row
  iteration count, `PBKDF2_ITERATIONS` var). The same code therefore verifies
  the login **and** provisions Laoka rows byte-compatibly.
* **Provisioning** is find-or-create per module, best-effort and idempotent:
  * Sompitra row: uuid id, `pin_hash = ''` (legacy column, unused).
  * W.A.Y row: hashed in **W.A.Y's own** `salt:hash` PBKDF2-100k format,
    because that hash doubles as the μlogger Basic-Auth credential.
  * Laoka row: Laoka-format hash; legacy rows with a NULL password get merged.
* **Sessions**: central session in `home-db`; module sessions in each module's
  native mechanism (D1 rows for Sompitra/Laoka, signed token for W.A.Y).
* **Auto-repair**: any module 401 (or Laoka's `200 {user:null}`) with a live
  `home_session` mints that module's cookie and retries the request once.
  Sompitra's page middleware does the same (`src/lib/middleware.ts`).
* **Rate limiting**: failed logins are throttled per client IP (10/hour).

## Admin & lifecycle

* **First admin**: open `/bootstrap` while `home-db` has zero users. The first
  claim becomes admin and the route disappears. Optional `SETUP_TOKEN` secret
  protects the window.
* **`/admin` console** (central admin only): create a person (username +
  password + role — provisioned into all three modules immediately), reset a
  password, activate/deactivate an account. Deactivation blocks the central
  login; module data is preserved.
* **`/change-password`**: any signed-in person, applies to the whole app.
* **Logout** (`/logout`) destroys the central session and every module
  session it can reach server-side, then clears all four cookies.

## Request routing rules

1. `run_worker_first` sends `/ws`, `/laoka-ws`, `/ulogger*` — **plus the two
   module documents `/way/index.html` and `/laoka/index.html` and their shell
   URLs `/way/`, `/laoka/`** — to the Worker before static assets. The docs
   are session-gated; without this the edge would serve them signed-out.
2. Module mounts are registered **before** Sompitra's routes — Sompitra's
   `use('*', requireAuth)` catch-all would otherwise swallow `/way/*` and
   `/laoka/*`.
3. `/way/api/*` and `/laoka/api/*` have their prefix stripped and are
   dispatched to the module's own router; a 401 triggers the repair retry.
4. `/laoka-ws` is rewritten to `/ws` and dispatched through **Laoka's own
   entry** so its cookie auth still guards the DO upgrade. Home's `/ws`
   belongs to W.A.Y's FleetDO.
5. Laoka's own credential endpoints (`/api/auth/login|signup|logout|password`,
   `/api/invites*`) are **blocked with 403** — Home owns identity; this also
   closes a deactivation bypass.

## Databases

Four D1 databases, three of them the pre-existing production ones (unchanged
schemas, untouched data):

* `home-db` — new; schema in `migrations-home/` (0001: users, sessions,
  attempts; 0002: per-person ntfy channels + household `home_settings`).
  It holds identity AND notification identity, because a phone follows one
  ntfy topic — a channel belongs to a person, not to an app.
* `sompitra-db` — migrations in `migrations-sompitra/`.
* `way-db` — migrations in `migrations-way/`.
* `laoka` — migrations in `migrations-laoka/`.

Durable Objects: `FLEET_DO` (W.A.Y live fleet + chat) and `LOBBY` (Laoka
metadata-only fan-out). Cron `0 21 * * *` flushes the FleetDO into way-db —
**that cron is the "today" boundary for W.A.Y; never move it to UTC midnight.**

## Notifications (one channel per person)

Before the merge each app had its own idea of "where notifications go":
Sompitra pushed to a single household topic, W.A.Y owned a topic per person.
The merged app has **one channel per person**, owned by `home-db`
(`users.ntfy_topic`), and every module pushes to it:

* **Two publishers, one channel set.** Sompitra pushes through
  `src/lib/notify.ts` (which takes the whole `Env` and fans an event out to
  every active person's channel). W.A.Y has its own ntfy publisher inside the
  FleetDO, so its `getNotifyConfig()` reads the same home-db channels — and
  because the DO caches them, every channel/server write in `/settings` calls
  `reloadWayNotifications(env)`. `GET /way/api/debug/notify` reports exactly
  which topics W.A.Y resolved, which is how a drift between the two senders
  gets caught. Both facts are asserted by `npm run smoke`.
* The ntfy **server** is household-level (`home_settings.ntfy_server`), with
  a fallback read of Sompitra's legacy `app_settings.ntfy_server` so a deploy
  that has not moved it keeps working.
* W.A.Y's existing topics are **adopted** into home-db (case-insensitive
  username match) rather than abandoned — the phone is still following them.
* A person with no channel is skipped; the whole push no-ops without a
  server. Notifications are best-effort and never break a user action.

All of this is managed in one place: **`/settings`**, organised by who a
setting belongs to (You / the household / a module) rather than by app.

## Invariants worth defending

* Module databases and session mechanisms stay native — no shared sessions
  table, no cross-module queries in module code.
* `home-db` never stores module data and modules never store identity.
* Every module call from the identity engine is wrapped in try/catch: a
  broken module must never break login.
* One login per person, admin-managed; no self-signup anywhere.
* Colour palettes of each module are untouched — Laoka stays orange, W.A.Y
  indigo, Sompitra's Tailwind theme as it was. The **chrome** is shared; the
  module internals are never restyled.
* Module documents detect the shell themselves (`window.self !==
  window.top` → hide own chrome). Never try to style iframe content from the
  parent document — same-origin CSS cannot reach in; only an injected script
  or a fetch-time rewrite can.
* The chrome exists in exactly one file (`src/views/app-chrome.tsx`). Two
  hosts imported their own copies once and drifted — the module tabs ended up
  with emoji icons, no dark-mode toggle and no `.pb-safe`. `npm run smoke`
  now asserts the rendered tab bar is identical on every tab, which is what
  keeps that from silently returning.

## Testing locally

There is no test framework; `npm run smoke` (`scripts/smoke.mjs`, zero
dependencies) is the end-to-end gate and `npm run check` is the type gate.
Run both against a live dev server with `npm run verify` before deploying.
The smoke suite covers exactly the invariants above: one login → four
cookies, every tab/API 200, module documents gated, bad credentials
rejected, chrome identical everywhere, `home_session`-only self-repair.
