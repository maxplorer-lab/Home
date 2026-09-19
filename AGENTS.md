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
npm run smoke          # end-to-end checks against a RUNNING dev server
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
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0003_laoka_imports.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0004_two_channels.sql
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
    The nav is **two shapes from one list**: the bottom bar below `md`, the
    same six tabs horizontally in the header from `md` up (`HomeNav`). Add a
    tab to `HOME_TABS` and both shapes get it — never write a tab into one
    shape only. And **every tab keeps its own colour when inactive** (the six
    modules are meant to be read by colour); selection is the marker bar +
    tinted pill + bold label, never "the others go grey". The tint is the
    `--tab` custom property, not a literal `color:` — `html.dark .tab-tint`
    lifts it toward white because the raw tints are 1.9–2.6:1 on the dark bar
    at 10px. So: never grey an inactive tab, never hardcode a colour in place
    of `--tab` (a literal cannot be lifted), and never dim the light mode (the
    brand hexes are already at their contrast ceiling on white).

    The same list is the SCREEN's colour, not just the tab's: the layout and
    the shells set `--accent` and `--accent-ink` on `<body>` from `HOME_TABS`,
    and the heading glyphs (`.accent-mark`), the `/settings` section headings,
    the money sub-nav's active pill and the 2px hairline under the header all
    read those two variables. So: never hardcode a hue in a heading, a pill or
    a primary button — use `var(--accent)` for a mark and `var(--accent-ink)`
    for anything filled with white text (white on the tint is only 3.9:1).
    Card headings take an `icon` from `ICONS`, never an emoji: an emoji is a
    colour picture the OS picks, so it cannot take the accent and it renders at
    a different size on every platform (emoji that ENCODE data — the Kiné
    legend, category icons, user dots — stay). Card headings, the module stage
    (`#home-module-stage`, which insets and rounds an embedded module) and the
    one typeface (`BrandFontLinks`, loaded by EVERY document including the auth
    screens) are all asserted by smoke section 18; a new page that skips
    `Layout`/`ModuleShell` must load the font itself.
    And a grid item's automatic minimum size is its min-content width: a card
    holding a `truncate` (nowrap) description needs `min-w-0` on the element
    that IS the grid item, or one long string gives the whole page a horizontal
    scrollbar on a phone (smoke section 18 fails on it).
15. **TWO ntfy channels per PERSON, both owned by home-db** (migrations-home
    0002 + 0004) — not one topic per app, and no longer one topic doing two
    jobs:
    * `users.ntfy_topic` — the 💬 **feed**: Sompitra expenses/income/Kiné, in
      the chat's wording, fanned out by `src/lib/notify.ts` to EVERY active
      person including whoever recorded it. Nothing filters it.
    * `users.way_topic` — 📍 **tracking**: W.A.Y's chat/entry/exit/stationary/
      moving/approach, routed by the RECIPIENT's grid
      (`way-db.notification_subs`), never to the person whose action it was,
      and subject to their quiet hours.
    Collapsing them back onto one topic breaks a rule either way: money must
    reach the person who recorded it, and a location event must not.
    **W.A.Y's DO does NOT go through `src/lib/notify.ts`** — it has its own
    ntfy publisher and resolves each recipient in `getNotifyConfig()`
    (FleetDO.ts), which reads `way_topic` from home-db, keyed for EVERY active
    home user. `way-db users.ntfy_topic` is the pre-merge fallback and applies
    ONLY when home-db has never heard of that username — an explicit "channel
    off" (NULL) must stay off, never silently fall back to the stale topic.
    Because the DO caches this, every channel/server write calls
    `reloadWayNotifications(env)`; without it a rotation looks like it failed
    for W.A.Y events only.
    **A phone is given its topic by `/way/`'s Users & topics screen**, so that
    screen answers from identity too (`/way/api/users` → `topicSource`), and
    its generate button writes through `setWayTopic()` — which also MIRRORS the
    value into `way-db`, because the standalone Worker is still a deployable
    build and must publish to the topic the phone really follows. Never delete
    either way-db copy without migrating first, or every phone silently stops
    receiving. `adoptWayTopics()` (admin button in /settings) promotes W.A.Y's
    topics into `way_topic` and never overwrites a channel someone already has.
16. The household ntfy **server** lives in home-db (`home_settings`), with a
    fallback read of Sompitra's legacy `app_settings.ntfy_server` and then of
    the deployment's `NTFY_URL`. Only an admin can change it, and it is written
    to both database copies on purpose. W.A.Y's DO resolves the same chain
    (setting → env → default), so the two halves must land on the SAME server:
    `npm run smoke` compares the value each side reports. And **a publish must
    report the server's answer** — `pushTo` returns `{ok, detail}` and **Send a
    test** shows it (`ntfy accepted it (200)`, `ntfy refused it (401): …`,
    `could not reach …`). Never reintroduce a push helper that discards the
    response: "Test sent" over a refused push is undiagnosable, and that button
    is only ever pressed when nothing is arriving.
17. `HOME_DB`'s `database_id` is the **real** `home-db` id (created at cutover).
    A
    placeholder passes `wrangler deploy --dry-run` and then hands the deployed
    Worker a dead identity database, so never let one back in.
    **Local state is keyed to that id**: change it and `wrangler dev` reads a
    different, empty sqlite file in `.wrangler/state/v3/d1/` — the symptoms are
    `maxx/adminpass123` answering `err=bad_credentials` and
    `d1 execute HOME_DB --local` reporting "no such table: users". Nothing is
    lost; the old file is still on disk. Either re-apply `migrations-home/*`
    locally and `/bootstrap` again, or give the binding the old data (the run
    doc records the swap, including how to prove which file a binding owns).
    For the cutover itself (existing deployments, real data, the phones), see
    **`CUTOVER.md`**.
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
    for every `device_id` used in auto events, and that id is the person's
    `way-db.users.username` **verbatim, case included** (`deviceId =
    user.username` in `src/way/routes/ingest.ts`) — production's people are
    `MaxX` and lowercase `niri`, so a row named `Niri` satisfies MaxX's arrivals
    and still fails niri's. Repair locally or remotely with
    `scripts/repair-way-messages-fk.sql` (idempotent; it derives the rows from
    `gps_pings` and `users` instead of hardcoding names).
    **Check the whole table, not just the parent**: D1 also fails to *prepare*
    an insert that names a column the table lacks, so a database missing a
    migration's `ALTER TABLE` breaks the same flush with a different error —
    production was missing `0007_chat_reactions.sql` (no `reactions`,
    `reaction_users`, `reaction_updated_at`). Compare `PRAGMA table_info(...)`
    on both sides when a flush is failing and the parent table is present.
    `npm run smoke` asserts `POST /way/api/flush` returns a real count and not
    `{error:true}`.
20. **Laoka's shopping list becomes ONE Sompitra expense, keyed by the week.**
    The button in Laoka's export sheet calls Sompitra's `POST /budget/import-laoka`
    (`GET /budget/laoka-import?week=N` is its status). `home-db.laoka_imports`
    holds one row per week, and the week id IS the expense's identity — so a
    second press is an UPDATE of the same transaction, never a second charge.
    Four rules to preserve when touching it:
    * **Never trust the ledger alone.** `sent` is answered by looking the
      transaction up in `sompitra-db`; a ledger row whose expense was deleted
      reports `stale: true`, and the next send re-creates and re-points rather
      than writing a dead id into the expense.
    * **A re-send updates `amount` + `notes` ONLY.** Date, description and
      category may be the household's own edits by then; refreshing them would
      silently undo a person's choice.
    * **Notify on `created` only.** Re-sending is a correction to numbers the
      chat already announced; a second "💸" line reads as a second purchase.
    * **The notes must stay CSV-shaped** — one `Name: Ar 1,234` line per priced
      line, A→Z, unpriced lines dropped. Sompitra's `parseItemLines` (and the
      itemized details panel) is what turns them back into a list; a different
      shape degrades the expense into a paragraph of text. `laokaPricedLines()`
      mirrors Laoka's own `buildCsv()` filtering, ordering and truncation.
    The CSV export path still exists and is unchanged; the button is an
    addition, not a replacement. `npm run smoke` asserts the identity property
    (same id, no new row) and the itemized render — and deliberately does NOT
    create an expense for a week that was never sent, reporting that half as
    **skipped** instead. To enable it locally, press Send once in Laoka.
21. **A template can be forgotten; a settled week cannot.** The Plan tab's
    **🗑 Discard the template** button calls `DELETE /laoka/api/weeks/:id/plan`
    (`src/laoka/routes/weeks.js`). It deletes EVERY plan the week owns — a
    leftover draft included — resets it to `planning`, clears `exported_at` and
    `generation`, and re-syncs the shopping list, which keeps exactly the Pantry
    lines (prices included) and drops every plan line. It refuses (409) a week
    that is **confirmed** or **archived**: `weeks.confirmed_at` is the boundary
    between a proposal and history, so the client never guesses which side it is
    on. Don't "helpfully" allow it on a settled week — the way out of one is a
    single-day swap or archiving. `npm run smoke` proves the routing, the
    session gate and the client wiring, but the destructive half is
    fixture-dependent and **skips** unless an open week is genuinely empty,
    because the suite must never wipe a household's real plan. When touching
    this route, run it by hand against a throwaway week (`POST /api/weeks` with
    a free start date, then `generate` → `save` → discard, then delete the week
    row with `wrangler d1 execute LAOKA_DB --local`), and watch the open-week
    limit of 2 while you do.

22. **W.A.Y's dashboard may only change WHEN state is drawn, never WHAT.**
    `public/way/index.html` draws the map from a cursor that trails live by
    `PLAYBACK_LAG_SECONDS` (25 s), commits track segments append-only
    (`commitTrail` / `drawTail` / `resetTrail`), moves persistent markers
    instead of rebuilding them per ping, and lets `updateFollowCamera` — the
    ONLY caller of `map.panTo` — glide the camera when the device leaves the
    middle half of the screen (`FOLLOW_DEAD_ZONE_SCREEN_FRACTION`; that size is
    a judgement call — see `project.md`, a third of each axis is too small to be
    comfortable). The old per-ping `redrawAllTracks()` +
    `panTo` lived in `handleNewPing`; nothing there may come back. Frozen: the
    speed ramp, walking dash, gap rule, stationary dots, `shouldDrawPoint`,
    the state machine, `pending_sync` → `gps_pings`/`messages`, the 21:00 cron
    and the Flush button. `devicePings` stays the COMPLETE ordered record the
    Trips card sums — the playback buffer is additive display state — and the
    HUD stays live (`map ~25s behind` is how the lag is disclosed, and it is the
    Smooth pace's badge only). The lag IS the pace: `playbackLagSeconds()` is
    the ONE number the cursor reads (25 s for Smooth, 0 for Live), and
    `setMapPace` / `applyMapPace` may only repaint the pills and call
    `redrawAllTracks()` — no fetch, no server setting, `localStorage` per
    device. The pills live in Settings → Map ONLY: smoke asserts nothing named
    `pace-switch` is in the map chrome. `npm run smoke` section 15 asserts the
    served page still carries every frozen value, that the ping path no longer
    redraws, and that the pace switch stays display-only.

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

`D:\Freebuff\Home` is its own git repository — branch **`main`**, matching
the three module repos, with `origin` =
`git@github.com:maxplorer-lab/Home.git`. Use `git diff` / `git status`
freely. `main` is pushed and tracks `origin/main`.

**Home is deployed**, at `https://home.<subdomain>.workers.dev`, and is now the
ONLY host: the three original Workers (`sompitra`, `way`, `laoka`) were deleted
on 2026-09-19, so `sompitra.<sub>`, `way.<sub>` and `laoka.<sub>` all answer
404/1042 and the module repos hold the rollback (each is one `wrangler deploy`
away, and no data was ever in them — D1 is bound by name, not owned by a
Worker). It is built by the Cloudflare Git integration on `main` (the
default `npx wrangler deploy`; `.npmrc` carries `legacy-peer-deps=true` because
wrangler 4.x wants `@cloudflare/workers-types` v5 while this project pins v4).
Secrets (`AUTH_PEPPER`, `SESSION_SECRET`, `SETUP_TOKEN`) go in with `wrangler
secret put` — a deployed Worker with none is inert, never open. The phones'
μlogger posts to `https://home.<subdomain>.workers.dev/ulogger`; **two DOs
ingesting at once is split-brain**, so only one host may own the pings.

History was rewritten once, before the first push, to purge a module name
that was never part of this app — a stray name in one comment, left over
from the module Laoka replaced — from every commit *and* from the old
objects. So any SHAs cited in older notes do not resolve now. Don't cite a
Home SHA in a doc without checking it still resolves; prefer file paths and
commit *subjects*.

The three standalone sources under `../Sompitra`, `../W.A.Y`, `../Laoka`
have their own separate repositories and their own history.

| Symptom | Look at |
| --- | --- |
| Login works but a module shows its own login screen | that module's`app.js`/head script bounces to `/login` when a fetch 401s; `src/identity.ts` repair helpers |
| A module 404s on an `/api/…` path | `run_worker_first` in `wrangler.jsonc` — asset paths are served by the edge before the Worker |
| Tab bar looks different on some tabs | both hosts must render `HomeTabBar` from `views/app-chrome.tsx` — a second, local tab bar is the bug |
| The mouse wheel does not scroll a module (Laoka) | its embed block must not set `overflow` on `html`/`body` — a root `overflow-x: hidden` stops the document being the viewport scroller. `npm run smoke` section 17 fails on it |
| A Laoka tab (History, Settings) cannot be reached in the shell | `#topnav .inner` must `flex-wrap: wrap`; the standalone bar only fits one line at md+, and the shell embeds it at any width |
| The last rows of a Laoka shopping list sit under the export ribbon | `body.with-totals #view` must out-specify the embed's plain `#view` padding — the `!important` on the base rule is what eats it |
| The Sompitra tab icon looks like a blank card | its receipt path relies on winding: body clockwise, the three rule lines counter-clockwise (nonzero rule). Reversed lines fill instead of punching through |
| An inactive tab looks greyed/dead | the colour must come from `--tab` on `.tab-tint` (`CHROME_CSS`); a literal `color:` or a `text-gray-*` utility on a tab is the bug |
| An inactive tab is unreadable in dark mode | `html.dark .tab-tint`'s `color-mix()` lift is missing — without it slate/violet measure 1.9–2.6:1 on the dark bar. It only works if the tint is `--tab` (see the rule above) |
| A tab exists in one shape but not the other | `HOME_TABS` in `views/app-chrome.tsx` is the single list; the bottom bar and `HomeNav` both map over it |
| The bottom bar shows on a desktop window | the `md:hidden` (bar) / `hidden md:flex` (header nav) split in `app-chrome.tsx` |
| Chrome/Brave on Android never offers "Install app" | `public/manifest.webmanifest` + the icons it points at: each file must exist **at** the advertised size, and the maskable must not be a byte-copy of `icon-512.png` (Android then clips the mark). `npm run smoke` section 16 checks the served bytes |
| Module still shows its own header/nav inside a tab | the module's own `window.self !== window.top` embed script — selectors drift when its UI changes |
| A page's headings are a different colour than the tab you tapped | `--accent` is not set on that page's `<body>`, or a heading hardcodes a hue. Both must come from `HOME_TABS` (smoke section 18 compares `--accent` with the active tab's `--tab`) |
| A page renders in a different typeface than the rest of the app | it does not load `<BrandFontLinks />` — the shell, Laoka's document, the chat room and the auth screens each need it (smoke section 18 reads the served bytes) |
| A card heading has no icon, or a blank gap | the `icon` name is not in `ICONS` — `Icon` falls back to an empty span, so the failure is silent. Heading labels are grey on purpose; only the glyph wears the accent |
| The whole page scrolls sideways on a phone (one screen only) | a grid item holding `truncate`/nowrap text needs `min-w-0` — its automatic minimum is min-content, so one long description (a Laoka import's title) widens the page. Smoke section 18 names the card |
| White text on a coloured button is hard to read | the button uses the module's tint instead of `--accent-ink` (white on `#0d9488` is 3.9:1; the ink variant is 5.3:1) |
| `npm run dev` fails with a syntax error inside `views/app-chrome.tsx` | a **backtick in `CHROME_CSS`** — it is a template literal, so a stray one ends the string early and the error surfaces further down the file (a failed build shows as *hanging* page loads, not an error page) |
| One tab's module no longer fills the window | the module stage: `#home-module-stage` (the inset) and `#home-module-frame` (the rounded, ringed panel) in `views/shell.tsx`. A module must stay inside the frame — the frame is what makes it read as a panel of Home |
| Chat bubbles never render as "mine" | `currentUser` failed to load — check the `/way/api/users/me` response shape (it is NOT enveloped) |
| A chat/`/ws` frame stops working after a WAY change | the socket carries pings AND chat; WAY ignores the chat frames, the chat page handles them — see both `ws.onmessage` handlers |
| Only some tabs render the same icons | `HomeTabBar` / `TabIcon` in `app-chrome.tsx`; assets under `public/` |
| Identity/login behaves oddly after a schema change | `migrations-home/0001_identity.sql` + the local D1 in `.wrangler/state` |
| A notification never arrives | the right column in **home-db** — `ntfy_topic` for money, `way_topic` for W.A.Y activity (not the app it came from). An empty channel is skipped silently; also check `home_settings.ntfy_server` |
| A topic receives nothing | in W.A.Y, a topic nobody subscribes to can never fire: `GET /way/api/debug/notify` lists recipient counts per event type. In Sompitra, check the person's `ntfy_topic` is set — and remember a person is NOT sent their own W.A.Y events by design |
| Sompitra notifications arrive but W.A.Y's don't (or to the wrong topic) | the FleetDO's `getNotifyConfig()` channel lookup + its cache: `GET /way/api/debug/notify` shows the exact topics and server it resolved |
| A phone gets nothing at night, but chat still arrives | **not a bug** — quiet hours (way-db `users.quiet_start`/`quiet_end`, 22–06 by default) mute every tracking event except chat. The 📍 card in `/settings` states the window and whether it is on now |
| Someone is ticked in W.A.Y's grid and still receives nothing | they have no **tracking** topic: the grid says yes, the events are addressed to a topic that does not exist, and nothing else complains. `/settings`' household card warns about exactly this, and `GET /way/api/debug/notify` reports `niri has no topic` |
| "Send a test" says sent but the phone stays quiet | it now reports ntfy's own answer: `ntfy refused it (401)` = the server wants a token (`wrangler secret put NTFY_TOKEN`), `could not reach …` = wrong URL/host, `no ntfy server is set` = neither the database value nor `NTFY_URL`. If it says **accepted** and still nothing arrives, the phone is subscribed to a different topic — compare the string on screen with the subscription |
| Money notifications never arrive on a fresh deployment, tracking ones do | the halves resolve the server separately (`src/lib/notify.ts` vs the DO's `getNotifyConfig()`); both must end on the same value, and smoke cross-checks the one each side reports |
| Local login breaks right after editing `HOME_DB`'s `database_id` | local D1 state is keyed to the database identity — the previous `.sqlite` is still in `.wrangler/state/v3/d1/`; either re-apply the migrations + `/bootstrap`, or give the binding the old data (rule 17, and the workspace run doc) |
| WAY activity alerts missing from the chat | they are auto chat rows (`is_auto`/`event_type`) written by the DO, not pushes — `sender` is null in the DO and becomes "System" in D1 |
| Sompitra events never appear in the chat | the DO's `/system-chat` allowlist (`EXTERNAL_SYSTEM_EVENTS`) and `postSystemChat` call in `src/lib/notify.ts`; the handler is best-effort by design, so failures only show in the console |
| A system event shows as a bubble from "System" instead of a pill | the chat renderer must branch on `is_auto` alone; a new `event_type` also needs a style in `AUTO_STYLE` (unknown types fall back via `AUTO_FALLBACK`) |
| Income and expenses look identical in the chat | they are typed separately (`expense` / `income`); check `NotifLine.kind` in `src/lib/notify.ts`, the DO's allowlist, and `AUTO_STYLE` in `public/chat/index.html` — all three must know both |
| `/way/api/chat/history` is always empty, map history has no tracks | the DO **flush** is failing — almost always the missing `devices` FK parent (rule 19). `POST /way/api/flush` returns the real error |
| Chat history looks frozen at some past day | `/api/chat/history` reads only what the flush has already written to `way-db`; the last 24h live in the DO and arrive over `/ws` |
| Nothing seems to happen when editing a module UI | you are editing a file the Worker does not serve — see below |
| The WAY marker is 25 s behind the device, or the map keeps re-centring | **not a bug** — the viewer draws on a delayed playback cursor and a dead-zone camera on purpose. The HUD stays live and shows `map ~25s behind`. If you need the newest ping now, switch the pace to **Live** (Settings → Map). See `project.md` → "The W.A.Y map is drawn on a playback clock" |
| A WAY track vanishes, or a trail stops growing | `resetTrail()` is the only thing that clears one (snapshot / track-eye / late `track` point). Check `trailFor(devId).drawnIdx` vs `devicePings[devId].length` in the console, and remember a hidden track (👁) still moves its marker |
| The WAY camera stops following for no reason | `map.on('zoomstart')` clears the follow: our own `flyTo`s must be wrapped in `ignoreMapEvents()` (a deadline, NOT a flag — a `flyTo` fires `zoomstart` twice) |
| A WAY ping arrives but the map does not move to it | that is the 25 s lag doing its job; the point is committed when the cursor reaches it. To see it immediately, look at `latestPing` (the HUD) rather than the marker, or switch the pace to **Live** |
| The pace switch is there but the marker does not look any fresher | check `localStorage.getItem('map_pace')` and `playbackLagSeconds()` in the console; a device whose newest ping is in the FUTURE (clock skew) keeps `playbackState` true either way, and the pill only repaints through `applyMapPace()` |

### What is actually served

The assets binding is `./public` **only** (`wrangler.jsonc`). W.A.Y's live
document is `public/way/index.html`; Laoka's is `public/laoka/index.html`.
The root `dashboard/` (an older copy of W.A.Y's frontend) and the empty
`sql/` were deleted for exactly this reason — they were never served, and
editing them for a "fix that did nothing" was a real false lead. Don't
reintroduce a second copy of a served file anywhere in the root.
