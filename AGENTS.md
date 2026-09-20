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
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0005_diagnostics.sql
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
    **Admin is the CENTRAL role, never a module flag.** The household card and
    the three admin POST handlers judge a session with `isSettingsAdmin()`,
    which reads `home-db.users.role` first (`/admin` gates on the same value)
    and keeps Sompitra's `is_admin` only as a FALLBACK. Provisioning never
    re-derives that flag, so gating on it alone hides the links to `/admin`
    and `/admin/diagnostics` from a real admin — the Home admin need not be
    the Sompitra one (`CUTOVER.md` §1c). Smoke section 10 pins both halves.
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
    **Scope, because this rule used to be read as "no fixed colours anywhere"
    and Sompitra's own screens contradicted it:** it governs HOME-OWNED
    surfaces — the chrome, the shell hosts, `/settings`. An embedded module's
    own screens keep the palette they shipped with (project.md's invariants),
    which is why Sompitra's money pages still carry their hardcoded Tailwind
    greens and blues.
    What is NOT module style is the **meaning of a money colour**: green in,
    red out, teal a period's net result, orange we owe, purple owed to us —
    plus the two stated exceptions (Sompitra's graded balance scale for cash on
    hand, and Kiné's session tiles). A money screen that prints "Net" or
    "owed to us" in a colour the legend does not own is a bug, not a style
    choice; smoke section 18 reads the SERVED pages and fails on exactly that
    (it caught `/budget/reports`, Sales and the Debts page).
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

    **The Chat tab's unread dot** is chrome too, so it lives here: the markup is
    `ChatIconWithDot` in BOTH bars (`data-chat-unread`; the bar is hidden from
    `md` up, so a hook in one shape only would never be seen), the CSS is
    `.chat-unread-dot` in `CHROME_CSS`, and the state is `CHAT_UNREAD_SCRIPT`,
    loaded by `layout.tsx` AND `shell.tsx`. It is a DOT and not a counter on
    purpose: a count has to be owned by whoever last saw the room, and a wrong
    number is worse than a vague dot. See rule 24.
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
    value into `way-db`, because that is what a **rollback** publishes from
    (`CUTOVER.md` §6: one `wrangler deploy` per module repo, D1 bound by id and
    never owned by a Worker). Never delete either way-db copy without migrating
    first, or every phone silently stops receiving. `adoptWayTopics()` (admin button in /settings) promotes W.A.Y's
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
    A placeholder passes `wrangler deploy --dry-run` and then hands the deployed
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
    only thing that moves the camera, and the only caller of `map.panBy` — run
    the follow CYCLE: the device roams a CIRCLE
    (`FOLLOW_ZONE_DIAMETER_FRACTION` of the shorter side, so it is 70% of the
    screen width on a phone and can never reach the corners the HUD and the
    badge strip own) while the map holds still, keeps going for
    `FOLLOW_PUSH_MS` past that edge, and is then SWEPT to the OPPOSITE edge of
    the circle with a spring ease (`FOLLOW_PULL_SPRING`, a few percent of
    overshoot). Three parts of that are load-bearing: the pull must keep moving
    WITH the device (it sweeps from the offset the device had when the pull
    began to -0.93 of it, so a device that drives on, turns or stops is still
    drawn); it must LAND JUST INSIDE the circle (`FOLLOW_PULL_LANDING`) — on it,
    the device would still be out on the frame the pull ended and the trigger
    would fire forever; and it must be TIMED BY THE DRIFT it just watched
    (`FOLLOW_PULL_RATIO`, floored by `FOLLOW_PULL_MIN_MS`), never by a fixed
    number of seconds, so the sweep crosses the same distance at the same
    relative speed whatever the device is doing. The old per-ping
    `redrawAllTracks()` + `panTo` lived in `handleNewPing`; nothing there may
    come back. Frozen: the
    speed ramp, walking dash, gap rule, stationary dots, `shouldDrawPoint`,
    the state machine, `pending_sync` → `gps_pings`/`messages`, the 21:00 cron
    and the Flush button. `devicePings` stays the COMPLETE ordered record the
    Trips card sums — the playback buffer is additive display state — and the
    HUD stays live, and the lag is disclosed in ONE place: a blue line under the
    pace pills in Settings → Map (`updatePaceNote`), shown on Smooth and gone on
    Live. It used to be a HUD badge — do not put it back; the HUD is the
    device's readout and was overcrowded.
    The lag IS the pace: `playbackLagSeconds()` is
    the ONE number the cursor reads (25 s for Smooth, 0 for Live), and
    `setMapPace` / `applyMapPace` may only repaint the pills and call
    `redrawAllTracks()` — no fetch, no server setting, `localStorage` per
    device. The pills live in Settings → Map ONLY: smoke asserts nothing named
    `pace-switch` is in the map chrome. `npm run smoke` section 15 asserts the
    served page still carries every frozen value, that the ping path no longer
    redraws, and that the pace switch stays display-only.

23. **"Someone is nearly home" is announced THREE ways, from ONE decision.**
    The entry timer is a push (`APPROACH_THRESHOLDS` = 60 s / 30 s, category
    `home` only, driving ≥ 15 km/h, heading at the fence), and a push can be
    missed — so the same crossing also (a) writes a **row in the chat** and
    (b) arms a **badge pulse** the map shows. All three are decided in the
    `for (const threshold of APPROACH_THRESHOLDS)` block inside
    `maybeNotifyApproach`, and smoke fails if one of the three goes missing.
    **The chat row is the record; the push is the alert.** Entry/exit have
    always written one (`maybeLogGeofenceEvent`), and the timer never did —
    which is exactly why the family read the 60 s / 30 s push as "missing from
    the chat": the notification arrived, the history did not. It is written
    **unconditionally**, before `notifyEvent` does its own per-recipient
    filtering, so a quiet-hours or unsubscribed crossing still lands in the
    record (`eventType: "approach"`, ⏳ amber, `.system-msg.approach`); the
    stationary / moving pushes stay push-only on purpose — those fire on every
    trip segment and would bury the rows that matter. Note the chat is the
    Durable Object's scrollback (the flush is nightly), so the row appears at
    once but reaches `way-db` with the next flush. It is deliberately NOT computed in the browser: the DO broadcasts
    `{type: "approach", threshold, place}` / `{cleared: true}` from
    `maybeNotifyApproach` itself, so the pulse and the notification can never
    disagree about whether a threshold was crossed. It is armed on the CROSSING,
    not on a successful publish, so the badge still pulses when the push is
    suppressed (quiet hours, cooldown, nobody subscribed) -- that is the case
    the pulse exists for. The client owns only the
    SHAPE and the WINDOW (`approachPulses`, `approachPulseFrom`,
    `dropExpiredPulses`): yellow at 60 s, red at 30 s, gone 60 s after the last
    threshold with no follow-up and instantly on entry or turn-away. Two traps:
    * The window is **wall time**, never ping-counted — a device that stops
      reporting mid-approach must stop pulsing too, which is why `handleApproach`
      arms a `setTimeout` as well as dropping expired pulses during a render.
    * A snapshot pulse carries `ageMs` computed on the SERVER's clock. Never
      subtract the browser's `Date.now()` from a server `at` — a phone minutes
      off would silently eat the whole window.
    **The visual is split in two, and the split is not cosmetic.**
    `#badge-strip` is `overflow-y: auto`, so anything drawn outside a card is
    clipped to a ~170 px column: the first version animated rings on the card
    and was, in practice, invisible. So (a) the CARD carries identity only — a
    **3px band drawn INWARD** (`inset 0 0 0 3px`, animated between full and half
    opacity, plus a soft inset glow; `approach-card-yellow` /
    `approach-card-red`) — which by construction cannot be clipped, and which is
    why **no rule there animates `border-color`**: a 1px edge is what read as
    "barely visible" the first time. And (b) `#approach-radar-layer`, a
    `position: fixed` sibling of `#map` at `z-index: 1001`, carries the
    **sweep**: rings anchored on that badge's centre (`renderApproachRadar` →
    `positionApproachRadar`, from the card's own `getBoundingClientRect`), flying
    across the map and fading out. Move that layer inside the strip and the cue
    disappears again; smoke asserts the layer precedes `#badge-strip` in the
    document for that reason. The rings are SVG circles with
    `vector-effect: non-scaling-stroke` — a scaled div would thicken its border
    into a band, and animating width/height instead would put a layout animation
    on the same main thread as the map's rAF loop.
    **The countdown takes the status line; it does not add one.** The card has
    one 9px row answering "what is happening right now?" — `Live` / `4 Min Ago`
    / the clock — and while a pulse is on that row IS the approach line
    (`→ Home1 · ~30s`, in the pulse's colour). A second row just for a countdown
    was a temporary line in a very small card, and freshness comes straight back
    when the pulse ends. `statusRow` in `renderBadges` is the one place that
    decides which of the two it prints.
    `renderBadges()` rebuilds every badge, so the pulse is re-applied on every
    render (like the cached address) and the radar re-anchored; `data-device` on
    each card is what makes the anchor findable, and a resize / orientation
    change / strip scroll re-anchors it. `npm run smoke` section 15 asserts both
    halves, and `GET /way/api/debug/notify` reports the DO's build
    (`notify-v13-sum-partition`).

24. **Unread is a WATERMARK, not a count.** `chat_last_seen`
    (`localStorage`, per device, an ISO instant) is compared against the newest
    `chat_messages.created_at` the DO reports at `GET /way/api/chat/latest`
    (reached through the Worker, session-gated; D1 cannot answer this — the
    flush is nightly). `CHAT_UNREAD_SCRIPT` polls it on EVERY page, and:
    * on `/chat` nothing is ever "unread": that same poll advances the
      watermark instead (so the dot is off the moment you are in the room);
    * the FIRST poll on a device adopts the existing backlog as seen — without
      that, a fresh install badges yesterday's messages with no way to clear
      them short of opening the chat;
    * a failed fetch paints nothing. An unread dot that appears because the
      network blipped teaches people to ignore the dot.
    The comparison is a plain string compare, so `created_at` must stay an ISO
    instant. The dot is asserted for BOTH bars and for a real watermark answer
    in smoke section 5.

25. **Anything above 120 km/h is GPS jitter — in BOTH directions the number can
    arrive.** `PRE_FILTER_SPEED_LIMIT` (`src/way/config.ts`) is the single
    source, and the two halves are enforced at different layers on purpose:
    * a ping whose **position** implies more than the limit is dropped WHOLE,
      silently, before the state machine (`isGlitch`, called in
      `FleetDO.handleIngest`). The upload still answers `{"error":false}`, so a
      test ping that "did not move the marker" was probably just over the
      limit. Smokes's rule: keep every synthetic ping at or below the limit.
    * a ping whose **reported** μlogger speed claims more keeps its position and
      loses only that field (`ping.vel = null` at intake, plus the same check
      inside `processPing` so no library caller can bypass it). It is the one
      number the position check CANNOT see, since it travels with the ping
      independently of the coordinates — and it otherwise reaches the
      classification, the rolling speed average, the live HUD, the stored row,
      `pending_sync` and the approach ETA.
    It is **discarded, never clamped**: a clamp would invent a 120 km/h drive
    out of a jitter ping. `npm run smoke` section 15 asserts both halves and
    that they read one constant; the run doc carries the real end-to-end proof
    (three μlogger uploads: 200 km/h claimed, 720 km/h implied, 90 km/h honest).

26. **A REPORTED speed is only believed when the coordinates corroborate it.**
    μlogger's `speed` field is captured by the phone's GNSS chip, independently
    of the coordinates it travels with — and indoors a parked phone reports
    **5–30 km/h** while its fixes stay inside a few metres. Those fixes are often
    accurate to a couple of metres, which is exactly why μlogger's own accuracy
    filter cannot catch this: that filter judges the FIX, never the movement.
    Believed, the number makes a device on a table look like it is driving, and
    three things follow: the ping is persisted as a track dot (it is outside any
    fence and "not stationary"), its distance lands in the driven totals, and
    the approach ETA is computed from it — so a parked phone can be announced as
    "~60s from Home".
    `reportedSpeedIsCredible()` is the test: the device must have MOVED
    `REPORTED_SPEED_MIN_MOVE_M` (20 m — deliberately the same order as
    `ANCHOR_RADIUS_M`, this app's existing unit of "that was real movement")
    since the previous ping. Like rule 25 it is applied twice: at the DO's
    intake, where an uncorroborated report is **replaced by the speed the
    positions imply** (`speedFromPositions` — replaced, NOT nulled: the device is
    real and merely parked, and a null prints "No signal" in the HUD's speed
    readout), and inside `processPing`, so no library caller can bypass it.
    Under `REPORTED_SPEED_MIN_GAP_S` (5 s) the coordinates cannot tell a crawl
    from a jittering fix — 5 m of jitter in one second IS 18 km/h — so a short
    gap keeps the report.
    This is not hypothetical: in the household's own history, 900 stored rows
    sat within 400 m of Home1 across three days with **every one** above the
    2 km/h stationary threshold, 831 of them classified driving, 7.78 km added
    to the driven totals — all of it a phone on a table.

27. **Two pings stamped in the SAME SECOND are judged, never skipped.** μlogger
    stamps every fix to whole seconds, so two genuine pings can carry the
    identical timestamp — and that is not "no elapsed time": it means the real
    gap is shorter than the clock can show. `isGlitch` used to return false for
    `dt <= 0`, so two same-second fixes kilometres apart were BOTH accepted; a
    latent hole, proven with a real two-ping upload (the second, 2 km out, is
    now dropped) and certified by mutation. The fix is a floor, not a ban:
    `GLITCH_TIME_FLOOR_S` (1 s — the stamp resolution) is what such a pair is
    judged against, so at most 33 m at the 120 limit can hide under it while
    this phone's harmless daily pairs (7 m, 11 m apart) still pass.
    **This was NOT the cause of the parked-phone triangle of 2026-09-19.** There
    the teleport arrived ALONE after a multi-hour silence (0.5 km/h implied, so
    no speed gate can see it) and then sat in the exit guard's buffer for 65 s,
    long enough for the guard to confirm. The tell is that the triangle's first
    row sits EXACTLY on the exit radius (90.0 m) and carries the wild ping's
    timestamp but the confirming ping's accuracy: it is `exitBoundaryPoint`'s
    interpolation — a crossing the app never observed. That class needs a
    witness test on the exit transition, not a distance limit.
28. **An exit WALKS three phases — inside → EXITING → OUTSIDE — and a crossing
    nobody watched never becomes one.** From a ping there is exactly ONE
    assignment of `OUTSIDE` in `state-machine.ts`, and it sits behind both the
    witness test and `EXIT_GUARD_SECONDS`: no single ping can move a device from
    inside a fence to outside it, and the departure event is keyed on the
    completed walk (`EXITING → OUTSIDE`) alone — nothing else announces a leave.
    The crossing may only *start* from a ping that MEASURED it: if the device had
    been silent longer than `EXIT_WITNESS_GAP_S` (120 s — between the 2–30 s move
    cadence and a parked phone's multi-minute gaps), the ping is dropped whole
    (no interpolated edge point on the exit radius, no leg, no distance, no chat
    row, no push, nothing drawn), the fence state resolves by position, and
    `settlePending` re-anchors the next accepted ping where the device really is,
    contributing zero distance. That is what silenced the 2026-09-19 triangle.
    **`UNKNOWN` is where an unwitnessed crossing lands, and it is not a state
    events may key on**: an arrival is *"the prior state was not inside"*
    (`CONFIRMED_INSIDE`/`EXITING`), never the literal name `OUTSIDE` — keying it
    on `OUTSIDE` lets one silent crossing swallow the NEXT real arrival, and with
    it the push that opens the gate. Guards: smoke section 15 (the walk, the
    single `OUTSIDE` assignment, the departure key, the arrival key), each
    falsified by mutation. Proven live 2026-09-19: the DO's own state file read
    `geoState = UNKNOWN`, a returning drive confirmed the entry, and
    `MaxX arrived at Home` was written — a row the literal-`OUTSIDE` key can
    never produce.

29. **Accuracy is gated SERVER-side, at the same 10 m the phone's own uploader
    uses.** µlogger drops worse-than-10 m fixes before uploading, and that
    client filter works (production: 0 over-limit rows from Niri in 10,960;
    exactly one in all 14,353, from 2026-08-27, before the setting) — but it is
    a PHONE setting, one config change (or a different client) away from off,
    and the backend would then trust whatever arrives. The gate is
    `PRE_FILTER_MAX_ACCURACY_M` (config) → `accuracyIsAcceptable()`
    (state-machine) → one call at the TOP of `FleetDO.handleIngest`, BEFORE the
    speed filters (a nonexistent measurement cannot be asked what it implies
    about speed). An over-limit fix is dropped WHOLE — no row, no distance, no
    broadcast, no event — and the upload still answers success, exactly the
    120 km/h contract. `<=` on purpose (µlogger itself accepts 10 m) and an
    ABSENT field is accepted: an omitted measurement is not a bad one. Know
    its limits: the 2026-09-19 wild fix claimed **9.6 m** and the parked
    scribble's fixes are 1–8 m, so this is a floor on a receiver's
    self-assessment, not a cure for a wrong position — it does not replace
    rules 25–28. Guards: smoke section 15 (config → alias, the call before
    `processPing`, null accepted, the `<=` boundary), each falsified by
    mutation. Proven live 2026-09-19: acc 25 m and 10.1 m dropped (the 10.1 m
    at the SAME coordinates as an accepted 10 m ping, so only the field
    differed), acc 9 m / 10 m / absent kept.

30. **Every deliberate silence is COUNTED, and that count is readable at
    `/admin/diagnostics`.** Rules 25–29 all drop pings SILENTLY on purpose
    (µlogger must never see an error), and the price of that contract is that
    "the phone was correctly filtered" and "the phone never uploaded" are the
    same observable from outside — which is what made the 2026-09-19/20
    real-world test unreadable. Two ledgers, split by FREQUENCY, and the split
    is the design:
    * **Tracking gates → the FleetDO's own SQLite** (`ingest_gates` counters +
      a bounded `ingest_drops` sample, written by `countGate()`). A parked phone
      produces thousands of collapsed points a night; pushing that volume into
      D1 to say "the same phone was collapsed again" is how a free-tier app
      dies. Read it at `GET /way/api/debug/notify` → `ingest`, and check the two
      sums: `received = accuracy + glitch + accepted` and `accepted = drawn +
      collapsed + unwitnessed + paused`. A sum that does not hold means a gate
      exists that nobody counts. Every branch of the persistence decision is
      exhaustive for exactly that reason — do not add one without counting it,
      and never let two of them count the same ping: a double count makes a sum
      *exceed* its total, which the page prints as "a gate nobody counts". The
      paused branch therefore excludes `unwitnessed` pings (those were already
      counted with their reason), which is the one combination that could hit
      both. `report-unbelievable` is a CORRECTION, not a drop, and sits outside
      both sums on purpose: its ping keeps going with the position-derived speed
      (rule 26), so it is counted in `accepted` — it is on the page because "we
      did not believe this device's km/h" is worth seeing, not because anything
      was dropped by it. The sums partition what was DROPPED, not every counter.
    * **Notification non-deliveries → home-db `diag_events`** (migration
      0005), written by `recordDiag()` from `src/lib/notify.ts`. A few rows a
      day, pruned to 90 days by the daily cron. This is the table that answers
      project.md's "the three ways a notification disappears without a trace"
      *after* the fact; the console.log it replaces only answered it to whoever
      happened to be tailing at that second. Kinds: `notify-skipped` (no server
      / no channel set), `notify-refused` (ntfy said no, or was unreachable),
      `notify-failed` (the push threw).
    The gate counters are DURABLE, so they survive an eviction (a parked-phone
    test can span one) — and that is exactly why they are **scoped to the build
    that wrote them**: `ensureSchema` stores `DO_BUILD` in the DO's `do_meta`
    table and clears `ingest_gates`/`ingest_drops` when it changes. Without that
    the two sums stay permanently skewed after any deploy, because a durable row
    counted under old code cannot be recounted under new code. This was found by
    mutation-testing this very feature — the sum was still broken after the
    mutant was restored, and nothing knew why. **So: change which gates count,
    and you MUST bump `DO_BUILD`.** One constant, used both by the debug probe
    and by that reset, so the two can never disagree; an empty `gates` list then
    means "a fresh deployment" or "a build bump just cleared them", never
    "nothing was ever dropped".
    `recordDiag`, `pruneDiag`, `countGate` and `readGateLedger` NEVER throw —
    a ledger that can fail the user action it was observing is worse than no
    ledger. Guards: smoke section 19, which
    proves it live (a real accuracy-25 µlogger upload, asserted to answer
    success, raise the counter AND sample its reason) as well as reading the
    contracts a test cannot reach.

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
| A person who IS an admin cannot see the admin links on `/settings` (or an admin POST bounces back to `/settings`) | they are a Home admin whose Sompitra row predates the merge, so `users.is_admin` is 0 there. The card and the handlers must judge with `isSettingsAdmin()` — central role first, module flag as a fallback (rule 13, `CUTOVER.md` §1c) |
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
| The HUD (or a stored row, or a Trips total) shows an impossible speed | the **reported** half of rule 25: `FleetDO.handleIngest` must null `ping.vel` above `PRE_FILTER_SPEED_LIMIT` *before* `processPing`, and `state-machine.ts` must refuse it too. A believable-but-wrong number (90 km/h on a parked device) is NOT filtered — the rule is only about the limit, so look elsewhere for that |
| A phone that has not moved draws a track, or a Trips total grows on its own | the **reported-speed** half of rule 26 — the speed field lies, not the coordinates. Check `reportedSpeedIsCredible` + `REPORTED_SPEED_MIN_MOVE_M` and the replacement block in `FleetDO.handleIngest`. Look at the fence too: a phone parked *outside* its home fence is never "inside" either, so nothing gets dropped by the inside rule (Home1 sits ~305 m from where the household's phones actually stop) |
| A device's track teleports, or a synthetic ping seems to be ignored | the **position** half of rule 25 — `isGlitch` drops a ping implying >120 km/h silently and the upload still answers success. Check the speed your test generated before suspecting the pipeline (a 5 s gap and a 1 km step is 720 km/h, no matter what the `speed` field says) |
| A save or a chat message "did nothing at all" | the network path, not the server: `apiJson` answers a rejected fetch as `{ok:false, status:0}` so the caller's alert runs, and the chat composer clears only after `sendWs` returns true — smoke sections 15 and 12 fail if either goes back to silence. DevTools' Offline switch reproduces it in one step |
| "Did the tracking rules actually do anything?" after a real-world test | `/admin/diagnostics` (admin-only). It is the ONLY way to tell "the phone was correctly filtered" from "the phone never uploaded" — every gate drops silently by contract (rule 30). Read the sums first: `received = accuracy + glitch + accepted`, `accepted = drawn + collapsed + unwitnessed + paused`. `collapsed` climbing with `drawn` flat is a parked phone working as designed, not a broken pipeline |
| `/admin/diagnostics` shows no gates at all | the counters are **DURABLE and build-scoped**, so exactly three things empty them: a fresh deployment, a **build-marker bump** (`ensureSchema` clears them when `DO_BUILD` changes), or the **Reset counters** button. A restart or an eviction does NOT — so if a restart seems to have cleared them, the code changed too. An empty list right after a deploy is normal; send one upload and they reappear. If it persists with `"ingest": null`, the FleetDO binding or `/debug-notify` is the problem (rule 30) |
| A notification vanished last Tuesday and nobody can say why | `diag_events` in **home-db** (`/admin/diagnostics` → Notification ledger). It holds every push that did NOT reach a phone, with ntfy's own words. Rows expire after 90 days (the daily cron's prune), and `ledger.total: 0` means every push has been landing. If the ledger is unreadable, migration `migrations-home/0005_diagnostics.sql` was never applied |
| A ping with a silly accuracy (say 50 m) still moves the dashboard | the gate is the FIRST thing in `FleetDO.handleIngest` (rule 29) — check `accuracyIsAcceptable` is still called before the speed filters and still reads `PRE_FILTER_MAX_ACCURACY_M` from config. And note the other direction: a client that sends NO accuracy always passes by design (null is accepted), so first check whether the field was sent at all |
| A track spikes out and back from a geofence while the phone is parked | two separate causes, and the rows tell them apart. **Same-second pair?** judged against `GLITCH_TIME_FLOOR_S`, never skipped (rule 27) — a pre-floor DO accepts it unseen. **First row of the pair exactly on the exit radius?** that is the guard's interpolated edge point, so read the ping that STARTS the exit: a far-out ping after a long silence passed every speed gate (0.5 km/h implied over hours) and the guard then confirmed on wall time. `pingsFlushed` counts only accepted pings, so it is the first honest number to read |
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
| The HUD's health slot reads `n/a` or `—`, or the badge shows no battery strip | μlogger reports **no battery level at all** (96 of 12,077 pings ever had one, all on the old app's first day) and the live push never carried the field, so `n/a` was permanent. The slot now falls back to GPS accuracy (`±1.6 m`, on every ping), and `—` only means a device's stored `lastStatus` predates the DO sending `accuracy` — one ping fixes it. Never print `n/a` again: smoke section 9b fails on it, and on the DO losing `accuracy` from the live push |
| The HUD's age reads `-1s ago` | the phone's clock runs ~1 s ahead of the viewer's: the age is `Date.now() - ping.timestamp` and must be **clamped at 0** (`now` under a second). Whatever the skew, an age can never be negative |
| The badge's address column is `—`, or appears and vanishes a few seconds later | `renderBadges()` rebuilds every badge on each ping, so the resolved text must be re-applied from `addressCache` (`cachedAddressLines`) — text written only by the fetch callback is wiped immediately. Check `localStorage['way_addresses']` and `describeAddress()`; a cached address >400 m from the device is hidden on purpose |
| A phone's uploads to `/ulogger` are rejected (401), or `addpos` says "Missing required parameter" | device auth is **case-sensitive** on `users.username` (`MaxX`, lowercase `niri` — a lowercase login works for the dashboard, not for a phone), and `addpos` wants `time` (seconds), not `timestamp`, with `speed` in **m/s** (the route converts to km/h) |
| The WAY marker is 25 s behind the device, or the map keeps moving | **not a bug** — the viewer draws on a delayed playback cursor and a follow camera that cycles on purpose. The HUD stays live, and the lag is named by the one blue line under the pace pills in **Settings → Map** (shown on Smooth, removed on Live). If you need the newest ping now, switch the pace to **Live**. See `project.md` → "The W.A.Y map is drawn on a playback clock" |
| The map drifts while the device is clearly inside the circle, or the device is left sitting at the edge after the camera moves | the follow cycle is DRIFT (map **still** while the device roams `FOLLOW_ZONE_DIAMETER_FRACTION` of the shorter side) → PUSH (map still for `FOLLOW_PUSH_MS` while the device shoves past the edge) → PULL (swept to the **opposite** edge, timed at `FOLLOW_PULL_RATIO` of the drift just watched). A camera that moves during the drift, that lands near the **middle** instead of the far edge, or that takes a fixed time regardless of speed, means `updateFollowCamera` was changed: smoke section 15 asserts all of it, that the sweep drives a live offset (`panBy`, never `panTo`/`setView`), and — by evaluating `pullEase` — that it overshoots its aim slightly on the way |
| The map keeps pulling, over and over, on a device that is standing still just outside the circle | the sweep must come to rest just INSIDE the circle (`FOLLOW_PULL_LANDING` = 0.93). At exactly the opposite extreme the device is still outside on the frame the pull ends, so the trigger fires again on the next frame and it loops forever — one degree of hysteresis is what ends it |
| A page you changed still looks old on a phone — the deploy is fine, the number did not move | first check WHICH build the phone is on: **WAY → Settings** prints `build 2026-09-19.6-superapp` under Log out (the marker only bumps when the WAY document itself changes). Each tab is a **fresh server-rendered page**, so switching tabs (or reopening the installed app) reloads it — but a tab that was already open through the deploy keeps its old document until you do. Assets are served `must-revalidate`, so it is never the HTTP cache. This is how the HUD's size change looked like it had not shipped: it had, and on a ≤420 px viewport it is only 33 px vs 30 px (the larger 42 px branch starts above 420 px, which is why a phone and a 423 px iframe render differently) |
| The HUD/speed readout is smaller than the desktop screenshot | `.spd-num` is 42 px, and the `@media (max-width: 420px)` block in `public/way/index.html` drops it to 33 px with a 138 px card — a 1 px width change across that boundary is a 9 px jump. Change the branch, not the desktop value, when tuning for phones |
| A cached page appeared for the wrong account, or an offline load showed a signed-in screen | a service worker cached a DOCUMENT. There are two (`public/sw.js` at `/`, `public/way/sw.js` at `/way/`) and the narrower scope wins for a /way/ URL, so both must keep the assets-only policy: no page in the precache list, and `req.mode === 'navigate' || req.destination === 'document'` returns before any cache is consulted. A policy change must also bump the cache name — that is what evicts the old entries. Smoke section 16 fails on both files |
| A Kiné payment does not show up as budget income | the sync resolves its account (`kineIncomeAccount` in `src/routes/kine.tsx`): the signed-in person's own account whose name starts with `Kin%` first, then any `Kiné Privée`. No such account → the "Sync to Budget Income" checkbox is not even offered. It used to look for `username='niri'` specifically, which quietly broke the feature for anyone else |
| A WAY track vanishes, or a trail stops growing | `resetTrail()` is the only thing that clears one (snapshot / track-eye / late `track` point). Check `trailFor(devId).drawnIdx` vs `devicePings[devId].length` in the console, and remember a hidden track (👁) still moves its marker |
| The WAY camera stops following for no reason | `map.on('zoomstart')` clears the follow: our own `flyTo`s must be wrapped in `ignoreMapEvents()` (a deadline, NOT a flag — a `flyTo` fires `zoomstart` twice) |
| A WAY ping arrives but the map does not move to it | that is the 25 s lag doing its job; the point is committed when the cursor reaches it. To see it immediately, look at `latestPing` (the HUD) rather than the marker, or switch the pace to **Live** |
| The pace switch is there but the marker does not look any fresher | check `localStorage.getItem('map_pace')` and `playbackLagSeconds()` in the console; the pills and the pace line only repaint through `applyMapPace()` → `updatePaceNote()`, and a device whose newest ping is in the FUTURE (clock skew) is drawn from its `latestPing` either way |
| The Chat tab shows a red dot, but the chat has nothing new in it | the dot is a **watermark**, not a count: `localStorage['chat_last_seen']` (an ISO instant) against the DO's newest `chat_messages.created_at`, polled from `/way/api/chat/latest` on every page. It never shows while you are ON `/chat` (that poll advances the watermark instead). A device seeing the dot for the first time adopts the whole backlog — if it is lit on a fresh device, the watermark was set by hand or the DO's timestamps are not ISO |
| A badge pulses (or keeps pulsing after the car has parked) | that is the **approach pulse**: the DO arms it from the same 60 s / 30 s thresholds that send the entry-timer push (the `v7` entry in `DO_BUILD`'s version history; the running build is reported at `/way/api/debug/notify`), yellow at 60 s and red at 30 s. It expires on **wall time** — 60 s from the 60 s trigger with no 30 s, 60 s from the 30 s trigger with no entry — and on arrival or turn-away (`clearApproachPulse`). Nothing pulsing means no threshold was crossed: the push, the pulse and the chat row are one decision, so a missing pulse is a missing notification, and `/way/api/debug/notify` says whether the per-event-type recipient count is 0 |
| The 60 s / 30 s push arrives but there is no row for it in the chat | the row is written by the same block that pushes (`maybeNotifyApproach`), so a missing row means the running Durable Object is **pre-v7** code (the `v7` line in `DO_BUILD`'s version history) — a deploy shuts Durable Objects down, but eventually consistently, so an instance can serve the old code until the rollout reaches it (or it goes idle and is evicted after 70–140 s). `GET /way/api/debug/notify` reports `build`; re-check it a minute after the deploy. A settings save does NOT restart the code — it only reloads that instance's notify cache. If the build is v7-or-later and the row is still absent, look for a `handleChatMessage` failure in the DO's logs (the flush writes `way-db` nightly, so the row will also be missing from `messages` until then) |
| A drive home never announces `arrived at Home` (no chat row, no push) while `left Home` still works | the entry was never CONFIRMED, and the usual cause is the **rolling average**, not the dwell: `processOutside` restarts `entryStartTime` on every ping whose `speedBuffer` average is ≥ `WALKING_DRIVING_THRESHOLD` (10 km/h), and that buffer holds only `SPEED_BUFFER_SIZE` (3) samples — after a 30 km/h approach the first stationary pings each reset the clock, so the 30 s `ENTRY_GUARD_SECONDS` cannot mature. Three stationary pings on a ~40 s cadence is what settles it (measured 2026-09-19). The second cause is the arrival key: if `maybeLogGeofenceEvent` is keyed on the literal `OUTSIDE` again, a device sitting in `UNKNOWN` (unwitnessed crossing, rule 28) can never announce its arrival |
| A `left Home` row plus a multi-km spike appear while the phone never left the fence | the exit started from a ping that did not witness the crossing (rule 28). Check `EXIT_WITNESS_GAP_S` against the move cadence, and that `s.geoState = "OUTSIDE"` is still the only `OUTSIDE` assignment — smoke section 15 fails on both, and on the DO drawing or storing an `unwitnessed` ping |
| The approach pulse runs but is barely visible, or the sweep is cut off at a box edge | the sweep must live in `#approach-radar-layer` (a `position: fixed` sibling of `#map`, NOT a child of `#badge-strip`) — the strip is `overflow-y: auto` and clips everything a card draws outside itself to a ~170 px column. Check `getComputedStyle(document.getElementById('badge-strip')).overflowY` and whether the radar element's `left`/`top` match its card's centre; smoke section 15 fails if the layer moves inside the strip |

### What is actually served

The assets binding is `./public` **only** (`wrangler.jsonc`). W.A.Y's live
document is `public/way/index.html`; Laoka's is `public/laoka/index.html`.
The root `dashboard/` (an older copy of W.A.Y's frontend) and the empty
`sql/` were deleted for exactly this reason — they were never served, and
editing them for a "fix that did nothing" was a real false lead. Don't
reintroduce a second copy of a served file anywhere in the root.

Two files in `public/` are deliberately unreferenced, and should stay:
`public/icons/icon.svg` and `public/icons/icon-maskable.svg` are the only
**vector** sources of the brand mark (the brand kit is rasters only), kept
beside the PNGs rendered from them. Everything else there is either served
directly or listed in a service worker's precache — a file that is neither is
dead weight: `favicon-48.png` was referenced by nothing and is gone.
