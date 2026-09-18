# AGENTS.md — Home (family super app)

Guidance for coding agents working in this repository.

## What this is

ONE Cloudflare Worker containing three modules with a single shared login.
The identity engine and admin console are the only "super app" code; the
modules themselves are the original standalone apps, barely modified.

```
src/
  index.tsx          merged Worker entry: mounts, repair middleware, cron
  identity.ts        ⭐ central login, password hashing, provisioning,
                     module-cookie minting, auto-repair helpers
  env.ts             all bindings (HOME_DB, DB, WAY_DB, LAOKA_DB, FLEET_DO,
                     LOBBY, ASSETS, secrets)
  routes/            Sompitra pages (auth.tsx also holds /bootstrap,
                     /change-password, /logout; admin.tsx is the console)
  way/               W.A.Y module (worker.ts adapts its entry; DB → WAY_DB)
  laoka/             Laoka module (worker.ts adapts its entry; DB → LAOKA_DB)
  db/schema.ts       Sompitra table types
  views/app-chrome.tsx ⭐ THE header + tab bar — both hosts import it
  views/layout.tsx     Sompitra page chrome + Card/StatCard/Btn
  views/shell.tsx      module tab host (iframe around WAY / Laoka / Chat)
public/
  way/               W.A.Y PWA shell + assets (namespaced) — NO chat code
  chat/              the family chat document (its own page, WAY's engine)
  laoka/             Laoka SPA (namespaced: /laoka-ws, /laoka/api/…)
scripts/smoke.mjs    `npm run smoke` — dependency-free end-to-end checks
migrations-home/     home-db schema (the ONLY db Home owns)
migrations-sompitra|way|laoka/   the modules' original migrations
```

Original standalone projects live outside this repo: `../Sompitra`,
`../W.A.Y`, `../Laoka` — consult them for module history, never edit them
expecting it to affect Home.

## Commands

```bash
npm run check          # tsc --noEmit (must pass before you claim done)
npm run smoke          # 36 end-to-end checks against a RUNNING dev server
npm run verify         # check + smoke — what "tested locally" means here
npm run deploy:dry-run # builds + resolves bindings without deploying
npm run dev            # wrangler dev on :8787 (use another port if taken)
npm run deploy         # wrangler deploy (see rule 17 first)
```

`npm run smoke` needs the server up first; point it at another port with
`BASE_URL=http://127.0.0.1:8793 npm run smoke`. It exits non-zero on any
regression, so it is safe to gate a deploy on. Defaults to the local dev
seed account (`maxx`); override with `SMOKE_USER` / `SMOKE_PASS`. Set
`SMOKE_ADMIN=0` when testing with a non-admin account.

Local DB setup (first time only):

```bash
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0001_identity.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0002_notifications.sql
npx wrangler d1 execute DB           --local --file=migrations-sompitra/0001_initial_schema.sql   # + 0002…0009
npx wrangler d1 execute WAY_DB       --local --file=migrations-way/0000_baseline.sql              # + 0001…0007
npx wrangler d1 execute LAOKA_DB     --local --file=migrations-laoka/0001_init.sql                # + 0002…0008
```

## Non-obvious rules (violating these has caused real bugs)

1. **Mount order in `src/index.tsx`**: module mounts MUST be registered
   before Sompitra's routes — its `use('*', requireAuth)` catches everything.
2. **Cookie retries must join with `"; "`, never `Headers.append`** (which
   joins with `", "` and produces unreadable Cookie headers). See
   `withRepair` in `src/index.tsx`.
3. **Response headers are immutable** once a handler returns; mint fresh
   `new Response(res.body, res)` before touching headers.
4. **Post-`next()` header mutation in Hono must use
   `c.header('Set-Cookie', v, { append: true })`** — reassigning `c.res` or
   returning from middleware silently drops the mutation.
5. **W.A.Y-provisioned passwords must use W.A.Y's own hash format**
   (`salt:hash` hex, PBKDF2-100k) because the same hash authenticates
   μlogger Basic Auth. Everything else uses the peppered Laoka format.
6. **Laoka's embedded auth endpoints are intentionally 403'd**
   (`src/laoka/worker.ts`). Don't "fix" that; it enforces one identity.
7. **Cron `0 21 * * *` is W.A.Y's midnight** (UTC+3). Don't move it.
8. **`AUTH_PEPPER` is required** for any login/creation; ≥16 chars. For dev
   it's in `.dev.vars`; in prod `wrangler secret put AUTH_PEPPER`.
9. `public/` is served static-first by the edge — API-ish new paths must be
   added to `run_worker_first` in `wrangler.jsonc` or they'll 404 on the
   assets layer. The module shells rely on this: `/way/`, `/laoka/`,
   `/way/index.html`, `/laoka/index.html` are all in the list so the
   Worker can session-gate the module documents.
10. **The parent page cannot style iframe content** — even same-origin. The
    WAY/Laoka embed chrome-hiding lives in each module's own head script
    (`window.self !== window.top`). If a module UI changes, check its embed
    script still matches its selectors.
11. Chat is its OWN page: `/chat` is a ModuleShell around
    `/chat/index.html`. That document is W.A.Y's original chat engine moved
    out of WAY (same `/ws` socket, same FleetDO, same render/reply/reaction
    code) — WAY has no chat markup, CSS or JS left, and both Sompitra's old
    chat route and WAY's `?view=chat` mode are deleted on purpose. The chat
    document is in `run_worker_first` and session-gated like the others.
    The shell host body is forced dark (`bg-[#0a0a0c]`) for the chat tab so
    the iframe's transparent edges never show a light seam.
    `/way/api/users/me` answers with the payload ITSELF (no `{success,data}`
    envelope) — both WAY and the chat page read the fields directly; a
    `r.success` check silently leaves `currentUser` null and every bubble
    renders as someone else's.
12. Don't rename the D1 binding `DB` (Sompitra) — Laoka's standalone code
    reads `env.DB` and the adapter remaps it to `LAOKA_DB` explicitly.
13. **`/settings` is the ONE settings surface** (`src/routes/settings.tsx`),
    organised by who a setting belongs to — You / the household / a module —
    not by which app it came from. Module-specific panels are being folded
    into it; until then the W.A.Y and Laoka sections link into their own
    UIs. Notification settings live here and nowhere else.
14. **One chrome, one place**: the header and the tab bar are ONLY defined in
    `src/views/app-chrome.tsx` (`HomeHeader`, `HomeTabBar`, `CHROME_CSS`).
    `views/layout.tsx` (Sompitra pages) and `views/shell.tsx` (module tabs)
    both import them. Never re-implement the tab bar in a page — the two hosts
    drifted once and the module tabs ended up with emoji icons, no dark-mode
    toggle and no `.pb-safe`. Tab-bar icons are the real assets plus inline
    SVG (`TabSvg`); no emoji in the bar (content emoji is fine).
15. **One ntfy channel per PERSON, owned by home-db** (`users.ntfy_topic`) —
    not one topic per app and not one per module. Before this, Sompitra pushed
    to a single household topic and W.A.Y owned a topic per person; a phone
    follows exactly one topic, so the channel had to become an identity fact.
    `src/lib/notify.ts` now takes the whole `Env` (not a `D1Database`) and
    fans every event out to the channels in home-db; the old copy in
    Sompitra's `app_settings` is dead weight kept only for rollback. W.A.Y's
    existing topics were adopted by `adoptWayTopics()` (admin button in
    /settings, username-matched case-insensitively) — never delete
    `way-db users.ntfy_topic` without migrating first, or every phone silently
    stops receiving.
    **Both senders must agree.** Sompitra reads home-db live, but W.A.Y's
    FleetDO does NOT go through `src/lib/notify.ts` — it has its own ntfy
    publisher and resolves channels in `getNotifyConfig()` (FleetDO.ts), so
    that lookup reads home-db too (keyed for EVERY active home user). way-db's
    `ntfy_topic` is the pre-merge fallback and applies ONLY when home-db has
    never heard of that username — an explicit "channel off" (NULL) must stay
    off, never silently fall back to the stale topic. Because the DO caches
    this, every channel/server write in /settings calls
    `reloadWayNotifications(env)`; without it a rotation looks like it failed
    for W.A.Y events only.
16. The household ntfy **server** lives in home-db (`home_settings`), with a
    fallback read of Sompitra's legacy `app_settings.ntfy_server`. Only an
    admin can change it, and it is written to both places on purpose.
17. `HOME_DB`'s `database_id` is still the **placeholder**
    `00000000-0000-0000-0000-000000000000`. `wrangler deploy --dry-run` passes
    anyway. Create `home-db` and paste the real id BEFORE `npm run deploy`,
    otherwise the deployed Worker has a dead identity database.
    For the full production cutover (existing deployments, real data, the
    phones), follow **`CUTOVER.md`**.
18. **The chat carries EVERY module's activity, so the chat's data path is a
    shared dependency.** WAY's geofence transitions write system rows itself
    (`handleChatMessage` with `is_auto`), and Sompitra's money events arrive
    through the DO's `/system-chat`, posted by `src/way/system-chat.ts`
    (`postSystemChat`) from `src/lib/notify.ts`. The DO allowlists the event
    types (`EXTERNAL_SYSTEM_EVENTS` = expense / income / kine, reported live as
    `systemChatEvents` on `GET /way/api/debug/notify`) and always writes
    `sender: null`, so a system line can never impersonate a person; the intake
    is reachable ONLY through the DO binding, never as a public route. The chat
    page renders **any** `is_auto` row as a centred system pill, styled per
    event type with `AUTO_FALLBACK` for types it does not know yet — it must
    never fall through to a bubble.
    **Income and expense are SEPARATE event types on purpose.** Money in must
    not look like money out in a scrolling feed, so the split runs through
    `NotifLine.kind` → the DO's allowlist → the row's `event_type` → the page's
    `AUTO_STYLE`, using the red/green language Sompitra's own budget list and
    dashboard already use (`text-red-500` for `-`, `text-green-600` for `+`).
    Before the split there was one `budget` type for both; the page keeps a
    legacy `budget` alias mapping to the expense style so rows already in
    scrollback still render, but nothing posts it any more. `npm run smoke`
    asserts the two styles DIFFER (not merely that both exist) and drives a
    real income through the app to prove its row is typed `income`.
    Three invariants worth keeping:
    * `postSystemChat` lives in its own module (`src/way/system-chat.ts`) on
      purpose: importing it from `way/worker.ts` would drag WAY's whole runtime
      into Sompitra's notify lib and form an import cycle the moment
      `way/lib/notify.ts` needs a shared helper from `src/lib/notify.ts`.
    * Mirroring into the chat is INDEPENDENT of ntfy. A person with no channel
      and a household with no ntfy server still see every event in the chat.
    * The 200-char limit on chat input is **client-side only**; the DO enforces
      no length cap, which is what lets a system line carry a full transaction
      description. Don't add a server-side cap without checking that first.
19. **A missing `messages` FK parent silently kills the entire chat flush.**
    `messages.device_id` is `REFERENCES devices(device_id)`, and D1 resolves FK
    parents at write time, so if `devices` does not exist EVERY insert into
    `messages` fails — including rows whose `device_id` is NULL — and
    `flushToD1` aborts as a whole. That breaks chat history, map history/tracks
    and lets unsynced rows pile up in the DO while the live chat keeps working,
    so nothing looks wrong in the UI. The `devices` table must also hold a row
    for every `device_id` used in auto events (`MaxX`, `Niri`), because WAY's
    arrival/departure messages set it. Repair locally or remotely with
    `scripts/repair-way-messages-fk.sql` (idempotent). `npm run smoke` asserts
    `POST /way/api/flush` returns a real count and not `{error:true}`.

## Smoke test (local, after any identity change)

```bash
# in another terminal; B=http://127.0.0.1:<port>
curl -d "username=maxx&password=…" $B/login -c jar -o /dev/null -w "%{http_code} %{redirect_url}\n"
curl -b jar $B/                     -o /dev/null -w "dashboard %{http_code}\n"
curl -b jar $B/way/api/devices      -o /dev/null -w "way %{http_code}\n"
curl -b jar $B/laoka/api/bootstrap  -o /dev/null -w "laoka %{http_code}\n"
curl -b jar $B/admin                -o /dev/null -w "admin %{http_code}\n"
```

Expect 302→`/` on login and 200 everywhere else. With ONLY a `home_session`
cookie in the jar, each of those should still return 200 via auto-repair.
`npm run smoke` automates all of the above plus the gates, the chrome
consistency and the repair path — prefer it over hand-rolled curl.

## Troubleshooting map

`D:\Freebuff\Home` is its own git repository (initialised `master`,
baseline commit "Checkpoint the merged Home super app under version
control"). Use `git diff` / `git status` freely — but note that no remote
is configured, so nothing is pushed anywhere. The three standalone sources
under `../Sompitra`, `../W.A.Y`, `../Laoka` have their own separate
repositories and their own history.

| Symptom | Look at |
| --- | --- |
| Login works but a module shows its own login screen | that module's`app.js`/head script bounces to `/login` when a fetch 401s; `src/identity.ts` repair helpers |
| A module 404s on an `/api/…` path | `run_worker_first` in `wrangler.jsonc` — asset paths are served by the edge before the Worker |
| Tab bar looks different on some tabs | both hosts must render `HomeTabBar` from `views/app-chrome.tsx` — a second, local tab bar is the bug |
| Module still shows its own header/nav inside a tab | the module's own `window.self !== window.top` embed script — selectors drift when its UI changes |
| Chat bubbles never render as "mine" | `currentUser` failed to load — check the `/way/api/users/me` response shape (it is NOT enveloped) |
| A chat/`/ws` frame stops working after a WAY change | the socket carries pings AND chat; WAY ignores the chat frames, the chat page handles them — see both `ws.onmessage` handlers |
| Only some tabs render the same icons | `HomeTabBar` / `TabIcon` in `app-chrome.tsx`; assets under `public/` |
| Identity/login behaves oddly after a schema change | `migrations-home/0001_identity.sql` + the local D1 in `.wrangler/state` |
| A notification never arrives | `users.ntfy_topic` in **home-db** (not the app it came from) — an empty channel is skipped silently; also check the `home_settings.ntfy_server` value |
| Sompitra notifications arrive but W.A.Y's don't (or to the wrong topic) | the FleetDO's `getNotifyConfig()` channel lookup + its cache: `GET /way/api/debug/notify` shows the exact topics and server it resolved |
| WAY activity alerts missing from the chat | they are auto chat rows (`is_auto`/`event_type`) written by the DO, not pushes — `sender` is null in the DO and becomes "System" in D1 |
| Sompitra events never appear in the chat | the DO's `/system-chat` allowlist (`EXTERNAL_SYSTEM_EVENTS`) and `postSystemChat` call in `src/lib/notify.ts`; the handler is best-effort by design, so failures only show in the console |
| A system event shows as a bubble from "System" instead of a pill | the chat renderer must branch on `is_auto` alone; a new `event_type` also needs a style in `AUTO_STYLE` (unknown types fall back via `AUTO_FALLBACK`) |
| Income and expenses look identical in the chat | they are typed separately (`expense` / `income`); check `NotifLine.kind` in `src/lib/notify.ts`, the DO's allowlist, and `AUTO_STYLE` in `public/chat/index.html` — all three must know both |
| `/way/api/chat/history` is always empty, map history has no tracks | the DO **flush** is failing — almost always the missing `devices` FK parent (rule 19). `POST /way/api/flush` returns the real error |
| Chat history looks frozen at some past day | `/api/chat/history` reads only what the flush has already written to `way-db`; the last 24h live in the DO and arrive over `/ws` |
| Nothing seems to happen when editing a module UI | you are editing a file the Worker does not serve — see below |

### What is actually served

The assets binding is `./public` **only** (`wrangler.jsonc`). W.A.Y's live
document is `public/way/index.html`; Laoka's is `public/laoka/index.html`.
The root `dashboard/` (an older copy of W.A.Y's frontend) and the empty
`sql/` were deleted for exactly this reason — they were never served, and
editing them for a "fix that did nothing" was a real false lead. Don't
reintroduce a second copy of a served file anywhere in the root.
