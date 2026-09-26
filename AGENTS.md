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
npm run audit:remote   # REMOTE schema vs migrations-* (read-only, exits 1 on a gap)
npm run audit:module-state # module-scope request state in src/ (read-only; rule 38)
npm run audit:do-state   # request data on a DO's `this` (read-only; rule 39)
npm run deploy:dry-run # builds + resolves bindings without deploying
npm run dev            # wrangler dev on :8787 (use another port if taken)
npm run deploy         # wrangler deploy (see rule 17 first)
```

`npm run smoke` needs the server up first; point it at another port with
`BASE_URL=http://127.0.0.1:8793 npm run smoke`. It exits non-zero on any
regression, so it is safe to gate a deploy on. Defaults to the local dev
seed account (`maxx`); override with `SMOKE_USER` / `SMOKE_PASS`. Set
`SMOKE_ADMIN=0` when testing with a non-admin account.

`npm run audit:remote` talks to the REAL databases (read-only selects only) and is
the check rule 32 exists for: it answers "did every migration reach every
environment?" Pass `--dir <path> --binding <BINDING>` to audit one directory
instead of all four — which is how it can be falsified.

`npm run audit:module-state` parses every file under `src/` with the TypeScript
compiler and fails if any module-scope binding is written from inside a function
— the class rule 38 exists for. `npm run smoke` §24 runs the same scan, so a
normal `npm run verify` covers it; the standalone command is for looking at the
answer without a server up, and for CI.

`npm run audit:do-state` is its sibling one level down: it reads the Durable
Objects named in `wrangler.jsonc` and asserts that every field on `this` is
declared in `DO_STATE_POLICY` (scripts/lib/do-state.mjs) with the reason it is
object state, and that each field's writes match its declaration. Also read-only,
also no server, also green in a normal `npm run verify` via smoke §25.

The type gate and both audits are also **the CI gate**:
`.github/workflows/gates.yml` runs `npm run check`, `npm run audit:module-state`
and `npm run audit:do-state` on every pull request and on every push to `main` —
none of the three needs a server, a database, a secret or the network. A second
job runs the two falsification drivers (`scripts/one-off/2026-09-23-*/mutate.mjs`)
for the reason above: an audit that has been quietly disarmed prints a clean tree
for the rest of the project's life, so the gate has to be shown failing. `npm run
smoke` is deliberately NOT there — it wants a running `wrangler dev`, a seeded
local D1 and a resolved session, which makes it a local step (`npm run verify`),
not something to run on every PR. **Marking a check REQUIRED is a repo setting and
not a file:** Settings → Rules → require a status check, then pick `gates` (and
`guards` if the anti-vacuity job should block a merge too).

Local DB setup (first time only):

```bash
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0001_identity.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0002_notifications.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0003_laoka_imports.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0004_two_channels.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0005_diagnostics.sql
npx wrangler d1 execute HOME_DB      --local --file=migrations-home/0006_share_links.sql
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
    hand, and Kiné's session COUNTS, whose "paid" figure is money in and is
    therefore green like every other franc arriving). A money screen that prints "Net" or
    "owed to us" in a colour the legend does not own is a bug, not a style
    choice; smoke section 18 reads the SERVED pages and fails on exactly that
    (it caught `/budget/reports`, Sales and the Debts page).

    **One surface system, in the same file.** `CHROME_CSS` defines the only
    surfaces the app has — `--paper` (the table), `--sheet` (anything sitting on
    it) and `--rule` (the hairline between two facts) — plus the type scale
    (`.t-anchor` / `.t-value` / `.t-label` / `.t-micro`). A panel is `.card`;
    only the panel that LEADS a screen may also be `.card-lg`, and there is
    exactly ONE anchor figure per screen (home's cash on hand). So: never give a
    page its own `bg-white dark:bg-gray-800 … shadow-sm` card, never set the
    page background outside `--paper` (that is the one place the dark/late
    theme switch could disagree with itself), and never print a caption in
    `gray-400` — 2.5:1 on white. **Labels are sentence case**: the
    `text-[10px] … uppercase` micro-label this app used on every card, tile and
    sub-nav is retired, and smoke **section 26** fails if one comes back on any
    screen. Section 26 also *measures* the token contrast floors (6:1 for
    `--ink-2`, 4.5:1 for `--ink-3`, light and dark) rather than trusting a hex.

    **A comparison is not a list.** Two shapes exist for a set of figures, and
    which one is right is decided by how they are READ. A `.ledger` row (label
    left, figure right, a hairline between rows) is for facts compared DOWN a
    column — the balances, one account per row, where the label has to carry the
    direction in words. A `.tile` (a small surface holding ONE fact) is for
    facts compared ACROSS, about one subject — a Kiné client's sessions / paid /
    due, or the week's sessions against the week's money. Both are legitimate;
    the bug is applying one to the other's job, which is what happened to the
    Kiné summary on Home: it was three pastel boxes, then a ruled list of the
    same three facts, and a list is what a comparison looks like when nobody
    says which it is. So: a tile is a `.tile` from `CHROME_CSS` like every other
    surface, it carries NO colour of its own — the palette is spent on the
    FIGURE inside it, exactly as the ruled list spent it (green = money in, a
    balance green / yellow / red, a count in ink) — and a tile only ever appears
    INSIDE a `.card`, never as a row of panels competing with the anchor. Both
    halves are guarded in smoke section 26: the week's two tiles in the served
    page plus that they paint no colour, and the three tiles `KineClientStats`
    draws.

    **Dark mode has ONE signal: the `html.dark` class — never the OS.** The
    tokens are emitted once, under `html.dark`. This was written the other way
    round first (a second copy inside `@media (prefers-color-scheme: dark)`),
    on the premise that the Tailwind CDN ignores `tailwind.config`. **Probed in
    the browser, that premise is false here:** an element carrying only
    `dark:bg-gray-700` computes transparent with no `.dark` ancestor and
    `rgb(55,65,81)` with one — the emitted rule is
    `.dark\:bg-gray-700:is(.dark *)`. So every `dark:` utility in every page
    follows the class, and an OS-driven token copy is a *split*, not
    belt-and-braces: with an explicit "light" choice stored on a dark-OS phone
    the tokens went dark while `bg-gray-100` stayed light, so a box whose text
    colour is inherited `--ink` rendered light-on-light — invisible. It was
    found that way on `/settings` (both action links to Account). Section 26
    now **forbids** the media copy, and fails if a document ships the tokens
    without the bootstrap that sets the class they wait for.

    `html.dark` already means "the effective theme is dark": the bootstrap in
    the head of every document that loads `CHROME_CSS` (`views/layout.tsx`,
    `views/shell.tsx`, `routes/auth.tsx`) sets it from the switch's stored
    choice, or from the OS when nothing is stored. An explicit choice therefore
    contradicts nothing — the whole app moves with it. Both guards are falsified
    by `scripts/one-off/2026-09-23-theme-signal/mutate.mjs` (needs the dev
    server).

    **The front door is part of the app.** The three screens in
    `routes/auth.tsx` render through `AuthShell`, which loads `CHROME_CSS` as
    well as `<BrandFontLinks />` — the `body` font rule lives in `CHROME_CSS`,
    so a document that loads only the font request renders in the SYSTEM face.
    That was true of sign-in, claim and change-password until the design pass,
    which also had them loading `logo-1024.png` (982KB) for an 88px mark. Use
    `/icons/icon-192.png`, keep the failure copy a plain sentence (what
    happened, then what to do) and keep the messages emoji-free: section 26
    pins all three.
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

    **The Chat tab's unread cue** is chrome too, so it lives here: the markup is
    `ChatIconWithDot` in BOTH bars (`data-chat-unread`; the bar is hidden from
    `md` up, so a hook in one shape only would never be seen), the CSS is
    `.chat-unread-dot` in `CHROME_CSS`, and the state is `CHAT_UNREAD_SCRIPT`,
    loaded by `layout.tsx` AND `shell.tsx`. The TAB is a dot and not a counter on
    purpose — a number in a tab bar has to be owned by whoever last saw the room,
    and a wrong number is worse than a vague dot. Where there IS room for a
    number, Home prints one: the unread card under the month's figure, same
    watermark, same fetch (see rule 24). Both live in `app-chrome.tsx` so the
    card and the dot cannot drift into two ideas of "unread".
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
    `MaxX` and `Niri`, and a device row spelled any other way satisfies one
    person's arrivals while failing the other's (that is exactly what the
    pre-2026-09-20 lowercase `niri` did — rule 33, `CUTOVER.md` §1f). Repair locally or remotely with
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
    `generation`, and re-syncs the shopping list, which ends up EMPTY: every line
    in a week's list came from the plan, because the pantry is not part of a
    week's list at all (rule 35). It refuses (409) a week
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
    halves, and `GET /way/api/debug/notify` reports the DO's build (`DO_BUILD`;
    CUTOVER.md's post-deploy step names the value and smoke §12 keeps the two
    equal).

24. **Unread is a WATERMARK in the browser; the COUNT and the LINES are the
    server's answer to it.** `chat_last_seen` (`localStorage`, per device, an ISO
    instant) is the only state this app keeps about what has been read. It is
    sent to `GET /way/api/chat/latest?since=<watermark>` (through the Worker,
    session-gated; D1 cannot answer this — the flush is nightly), and the DO
    replies with `count` (how many arrived after that instant) plus `messages`:
    that many lines, NEWEST FIRST, bounded by `CHAT_UNREAD_LINES` and clipped by
    `CHAT_UNREAD_CHARS`. One example line is not the same answer as the lines —
    a card reading "3 new messages" over the newest one names the wrong thing,
    two of the three being invisible — and the bound is what keeps a 25 s poll on
    every page small. That one watermark drives both cues — the nav dot and
    Home's unread card — from one fetch, so they cannot disagree: the card is not
    a second counter to keep in sync, and when the DO left lines out, its last
    row says so (`+N earlier in the room`) rather than the count and the lines
    quietly differing. `CHAT_UNREAD_SCRIPT` polls it on EVERY page, and:
    * on `/chat` nothing is ever "unread": that same poll advances the
      watermark instead (so the dot and the card are off the moment you are in
      the room);
    * the FIRST poll on a device adopts the existing backlog as seen — without
      that, a fresh install badges yesterday's messages with no way to clear
      them short of opening the chat;
    * a failed fetch paints nothing and leaves the card exactly as it was. An
      unread cue that appears because the network blipped teaches people to
      ignore it.
    The comparison is a plain string compare, so `created_at` must stay an ISO
    instant — fixed width, always UTC, which is also what makes the DO's
    `created_at > ?` count mean the same thing the browser means.
    **Per DEVICE, not per person:** reading the room on a phone does not clear a
    desktop, because nothing is written server-side to mark a message read —
    that is what lets a new phone start clean instead of inheriting someone
    else's flags. Making it per-account is a bigger change than it looks (read
    state in the DO, written on open) and is deliberately not done.
    **The card is a GRID ITEM holding nowrap rows, so it needs `min-width: 0`**
    (the same trap as the `truncate`-in-a-grid-item lesson at rule 14). A grid
    item's automatic minimum size is its min-content width — for a row of nowrap
    text, the whole sentence — so without it the card does not clip, it widens
    its own track: on a 390 px phone the home page measured **498 px** with the
    figure beside it pushed off the screen, found exactly that way.
    Smoke section 5 asserts the dot for BOTH bars, the readout for its count and
    that it carries ONE LINE PER unread message, NEWEST FIRST and clipped, that
    `since` actually narrows the answer, and the card for its POSITION (second
    box, between the month's figure and the rooms), for being painted as TEXT
    (rows built as elements, `textContent` only), and for that `min-width: 0`.
    `scripts/one-off/2026-09-23-unread-card/mutate.mjs` falsifies those one at a
    time — M1 position, M2 markup, M3 the dropped watermark, M4 the pre-shown
    card, M5 one-line-regardless-of-count, M6 oldest-first, M7 the dropped
    clip, M8 the lost `min-width`.

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

31. **A live share is a GRANT, not a page — and it is the ONE door an outsider
    can open.** `/live` (the document) plus `/live/api/state?pin=…` (the data)
    let an admin show ONE device to ONE person who has no account: they type a
    6-digit code and watch that device's map, and nothing else in the app is
    reachable from there.    `migrations-home/0006` creates `share_links` (subject
    device, label, the pin HASH, who created it, `expires_at`, `revoked_at`,
    `last_used_at`). Every choice below is a refusal of something easier, and
    each one has a guard in smoke section 20 — which proves the live flow (mint,
    wrong code, resolve, revoke) as well as the contracts a test cannot stage:
    * **Who may be shared is a device WITH AN ACCOUNT**, decided in ONE function
      (`listShareTargets` / `resolveShareTarget` in `lib/share.ts`, joining
      `devices.device_id` to `users.username`) and asked by BOTH doors — the
      console's picker and the mint route. Do not go back to listing one table
      while validating against another: production's `devices` used to hold a
      leftover `Niri` (capital N, no account, not one ping in its life) beside
      the real `niri` (9,679 of them) — one person as two spellings, merged on
      2026-09-20 (`CUTOVER.md` §1f) — so the picker offered a person the mint
      then refused, at the exact moment an admin had decided.
    * **The viewer reads the person's OWN name, resolved from the subject.**
      `createShare` takes no label at all and the console has no text box for
      one, so no request body can name one person while sharing another's map;
      the stored `label` is only the record of what that grant promised, and the
      page re-reads the name so a rename cannot leave an outsider watching an old
      one. The map row picks the person and NAMES them on the button.
    * **One live code per device** (`replaceOpenShares`): minting for a person
      replaces whatever was open for them, so "who is being shared" always has
      one answer. Two codes for two DIFFERENT people is the case **Revoke all**
      exists for. A failed mint must not revoke anything — the replacement runs
      AFTER the create.
    * **The pin is hashed, never looked up.** `createShare` stores it with the
      same peppered scheme as a password, so `resolveSharePin` VERIFIES it
      against the recent grants (`created_at` inside 7 days, `LIMIT 25`) rather
      than selecting a row by it. Nothing may `SELECT * FROM share_links`:
      `SHARE_COLUMNS` is the console's allowlist, and the hash columns are
      selected only on the resolve path.
    * **The viewer mints nothing.** No cookie, no session, no socket into the
      chat's DO. `/live` is served with `X-Robots-Tag: noindex` and is linked
      from nowhere in the product, and the state answers `no-store` — a cached
      location is one that revoking the code cannot take back.
    * **ONE device, by the grant's subject, from the DO.** `buildShareState`
      reads a single `device_id` in BOTH its query and its bind, and reads the
      **FleetDO and not `way-db`**: D1 learns positions only at the nightly
      flush, so a share reading it would show yesterday's commute. The answer is
      a bounded slice of today's `pending_sync` (strided above
      `SHARE_TRACK_MAX`, with `trackTotal` so the page can say it is sampled) —
      no chat, no other device, no distance totals, no battery, no accuracy.
    * **Refusals are separable, and recorded.** `expired` and `revoked` are NOT
      reported as `bad_pin`: the viewer is a close one, so "this link ended at
      midnight" is actionable while "wrong pin" sends them hunting a typo that
      is not there. Every refusal lands in the diagnostics ledger as
      `share-refused` — **on both paths** (a pin matching nothing, and a pin
      matching a grant that has ended), because a guard that searches the whole
      file keeps passing while one path quietly stops receipting.
    * **Guessing is not free.** `pinRateLimited` runs BEFORE the pin is verified
      (per caller, 10 failures an hour), and a resolved pin CLEARS that caller's
      failures: a relative who fat-fingers twice and then gets it right must not
      be two steps closer to a lockout, and an attacker never resolves anything.
    * **It ends.** The code expires at the next **00:00 UTC**, computed from the
      clock and not extendable, and an admin can revoke it immediately. Note
      this is deliberately NOT the app's own day boundary (21:00 UTC, the W.A.Y
      flush): a person thinks in calendar days, so a pin minted at 23:50 UTC
      lives ten minutes. The admin card says so.
    * **Revoking is one button, and the console keeps the receipt.** The card
      offers Revoke per code, plus **Revoke all** ("she has arrived") once more
      than one is open. A bulk revoke touches only grants the CLOCK has not
      already ended (`revoked_at IS NULL AND expires_at > now`) — stamping an
      expired one would credit an admin with an ending that never happened, and
      the Ended list would then lie about who ended what. Both revoke routes
      carry their OWN `requireCentralAdmin` gate: the live half of that guard
      cannot prove it, because `/admin`'s `use('*', requireAuth)` answers
      302 → /login whether or not the handler is gated (found by deleting the
      handler's gate and watching all 354 checks stay green), so the handler
      bodies are read as source too. What ended STAYS on the card — `Ended
      codes`, saying whether an admin or the clock ended it, because "who
      stopped sharing, and when" is the question a revoked code exists to
      answer — and an ended code leaves the active list (the two lists are one
      query apart, and a bug there is how a revoked code kept offering a Revoke
      button).
    * **`last_used_at` is a HEARTBEAT, not an audit log.** The viewer polls every
      few seconds, so the stamp is written only when it is older than a minute,
      decided IN the statement (one round trip, no read-then-write). The console
      prints it to the minute ("opened 12:40"), which is the resolution anyone
      reads; an unconditional write would be a D1 write every few seconds per
      viewer for a number nobody looks at that closely.
    * **The window IS the grant — creation to revoke-or-midnight.** The track a
      viewer sees starts at the moment the code was minted, not at midnight: an
      outsider handed a code at 14:00 has no business seeing where the car went
      this morning. It travels as `since` on the DO request and is REQUIRED at
      the far end — `buildShareState` with no `since` returns NO track rather
      than the whole day, and the only thing always served is the live position,
      because that is the point of the share. The page prints the two apart
      ("since 14:02 · 6 points"), and falls back to "today" only when the DO
      answers without a window, which is the truth about that answer.
    * **The lower badge is a HUD panel that resolves its own address.** Same
      shape as the household map's HUD (dark in both themes, hairline over the
      status row), showing the street with its number and then the suburb and
      first division from Nominatim, on the page's own 10 s clock — never on the
      5 s poll, and never at all while the device sits where we already resolved
      it. Past 400 m of drift the text is dropped, because a stale address is
      worse than a dash: it looks authoritative.
    * **Minting has TWO doors and ONE authority.** The console (`/admin`) is
      the household-wide card; **WAY → Settings → Map**, under the pace switch,
      is the same grant asked from the device you are looking at (routes
      `GET/POST /way/api/share`, `POST /way/api/share/revoke`). Do not add a
      third place that decides who may share: `shareMinter` in
      `src/way/routes/dashboard-api.ts` is that decision, and it reads the
      CENTRAL account's role whenever `HOME_DB` is bound (falling back to the
      W.A.Y role only for a standalone deployment). The GET answers
      `canShare` to any signed-in person so a non-admin is told WHY the button
      is missing; every write is `403` for them. A granted code is shown once,
      is never listed afterwards (no pin, no hash), is never written to
      `localStorage`/`sessionStorage`, and Stop sharing clears it from memory so
      a revoked code cannot linger as a copyable link.
    * **The badge wears the household map's speedometer, showing the LIVE
      speed.** A large tabular figure with `km/h` under it, coloured by the same
      four-stop ramp the household trail is drawn from — and that ramp lives in
      `/shared/playback.js` (`HomePlayback.SPEED_STOPS`), because two copies of a
      palette cannot promise to agree; WAY's `speedColor()` is a one-line
      delegation to it. The figure is the **newest fix's** number, read straight
      out of the payload, while the dot on the map is still gliding 25 s behind:
      the delay lives in where the dot is DRAWN, never in what the badge SAYS.
      `--` is a real answer (no speed reported yet), not a zero. Do not add a
      second colour list, and do not move the figure onto the delayed clock.
    * **The badge's footer WRAPS; it must not truncate.** It carries the state
      word, the window, the point count and when the code dies — on a phone an
      ellipsis ate whichever of those did not fit, usually the one being asked
      about. Its parts are separate `<span>`s (separators are CSS `::before`, so
      none is left dangling at a wrap point).
    The marker moved for this feature — the build that introduced it is
    `notify-v15-share-window`: an instance older than that answers **404** on
    `/share-state`, which is how "the share is blank" stays distinguishable from
    "the instance is running old code" — and a *v14* instance would answer 200
    while ignoring the window, which is why the marker had to move with this
    feature rather than with the next one. Read the CURRENT value from
    `DO_BUILD`: CUTOVER.md's post-deploy step names it and smoke §12 keeps the
    runbook and the code equal, so this file does not restate it. `0006` must be applied to **home-db**
    (local and remote) — and note that a deploy does NOT do it (rule 32).
    Without the table the READS stay quiet on purpose (`listShares` returns an
    empty list rather than 500ing the console, and the map's GET answers
    `open: []`), so both doors look healthy and only the MINT fails. Precisely
    because that is the likeliest break, the mint must NAME its remedy:
    `createShare` catches the throw, returns `no_table`, and `shareErrorText` says
    which file to run — through both doors. It did not, until 2026-09-20: the
    bare throw left a 500 with NO body, so the page could only fall back to
    "Could not generate a code." — a sentence that told the household nothing and
    cost a day. Do not put an unwrapped `HOME_DB` write back on this path.
    What it deliberately does NOT do: tell the person being watched. That is an
    ADMIN capability, exercised by someone acting for the household (as when
    creating accounts or resetting a password); the grant records WHO created
    it, and every refused attempt is receipted, so it is accountable even where
    it is not announced.

32. **A schema change is NOT part of a deploy.** `migrations-home/*.sql` is applied
    BY HAND, per environment (`npx wrangler d1 execute HOME_DB --remote --file=…`),
    and nothing in `npm run check`, the build or the deploy touches it. So the code
    can be live and correct while the table it writes does not exist — which is
    exactly how live shares became un-mintable in production on 2026-09-20. After
    adding a migration: apply it everywhere, then PROVE it landed with
    `npm run audit:remote`, which compares all four remote databases against their
    `migrations-*` directories in one read-only pass and exits 1 on any gap —
    because the absence is otherwise invisible: no error, no log entry, no failed
    check (the run is spelled out in `CUTOVER.md` §1b). Two habits follow from the same fact: a write path that needs a
    new table must ANSWER with that fact (a named reason, never a bodiless 500),
    and `CUTOVER.md` §1b must stay the true list of what every environment has.

33. **A person's name is a KEY, and there is exactly ONE spelling of it.** It is
    `way-db.users.username` (which μlogger authenticates with), `gps_pings.device_id`
    and `devices.device_id` (which every marker, trip and badge is drawn by),
    Sompitra's `users.id`, and the owner of an ntfy topic. So a lookup **folds
    case** everywhere — Home's login always did (`lower(username) = lower(?1)`),
    and as of 2026-09-20 so do W.A.Y's own credential check and
    `getUserByUsername` (exact hit preferred, so two rows differing only by case
    stay unambiguous) — and a device id is **re-resolved from the account on
    every fix** rather than trusted from the 30-day cookie, because a session
    minted before a rename would otherwise re-stamp the old spelling onto
    `gps_pings.device_id` and undo the rename silently. The live proof is in
    `npm run smoke` §19 (a login typed in another case, and a hand-forged
    pre-rename cookie whose fix must be recorded under the account's name). Two
    traps found while building it, both worth knowing: the gate ledger reads
    `ORDER BY id DESC`, so "the newest drop" is index 0 — searching from the
    other end matches an hour-old row and passes while the fault sits in the
    code — and the 25-row window persists across runs, so a guard must compare
    before/after rather than scan that history. Never fix a casing problem on the
    phone: the server accepting both spellings and storing one is the durable fix
    (`scripts/one-off/2026-09-20-rename-niri-to-Niri/`, §1f).
    The **human** door leaked the same way, and it is the one that bit on
    2026-09-22: `/ws` stamped the DO with the *token's* spelling, so Niri's
    pre-rename session kept writing `niri` onto chat rows — her own bubbles
    rendered as someone else's, and `notifyEvent`, whose source lookup was an
    **exact** match, found no account: MaxX's phone never rang while hers did,
    and `/debug-notify` still reported a send. Three folds, all needed, because
    each covers a different source: the socket resolves the account *before*
    `X-WAY-Username`; `notifyEvent` folds the **SOURCE** (a tracking event's
    source is a device id, spelled independently of the users row); and the
    reaction toggle reuses an existing key that differs only by case, so one
    person is never counted twice. The pages fold too (`sameName` in /chat), so
    history written before the fix still reads as theirs — and its sender field
    stays the account's own spelling from then on. Guarded in §19 ("a socket
    opened with the pre-rename casing…", "…the push lookup folds case…") plus the
    source reads beside them; falsified by
    `scripts/one-off/2026-09-22-one-spelling/mutate.mjs` — N1, N2, N3, N4, N6 are
    single faults, and **N5 is the PAIR** (socket *and* lookup both exact), which
    is the only shape that turns the live routing check red, since either layer
    alone routes correctly on its own. The fix moved `DO_BUILD` with it — the
    build that carried it is `notify-v16-one-spelling` — because a socket still
    stamping the old spelling routes wrongly while reporting a send. Read the
    CURRENT value from CUTOVER.md, which smoke §12 keeps equal to the code.
34. **A quantity has ONE arithmetic, and every surface that shows it calls that
    arithmetic.** Kilometres come from `computeLegsForDay` (geometry between
    consecutive stored points, split by classification) — the Trips card, the
    monthly totals **and the HUD badge's "km today"**. The stored
    `gps_pings.distance_km` is a DIFFERENT quantity (the engine's segment
    distance, spanning points that were collapsed and never stored), so a second
    surface summing it is not a rounding of the first: it read 1.8 against 0.9
    for one day, on one screen. The same rule decides drawing: a reviewed past
    day breaks its lines exactly where the live trail does — leg, gap **and
    change of mode** — and the GPX export keeps exactly the points
    `shouldDrawPoint` keeps. When adding a surface that reports distance, speed,
    legs or the day's track, call the existing function and let smoke §15 hold the
    two together; do not re-derive it from rows.
35. **The catalogue is TWO domains, `groups.is_pantry` is the line between them,
    and there are therefore TWO shopping lists.**

    | | MEAL | PANTRY |
    | --- | --- | --- |
    | who | Protein · Sides · Raw Salad | spices · oils · condiments · dry staples, plus whatever the household adds (toilet paper, soap) |
    | when | planned weekly by the planner | when the shelves say so — no schedule |
    | goes on | the week's shopping list | its own **to-buy** list |
    | counted | never (a count on a chicken thigh is a contradiction) | by hand, per item |
    | ends in | `?from_laoka=<week>` → one itemized expense | `?from_pantry=<trip>` → one itemized expense |

    The temptation is always to make them one list again. They are not one list,
    and each clause below is what keeps them apart:
    * **Meal side** — `getCatalogTree`, `getSelectedPools` and `syncShoppingLines`
      all filter `g.is_pantry = 0`. `getCatalogTree` must NOT select `i.stock`
      (one number on the meal side is how "count the chicken too" comes back),
      and `syncShoppingLines` must not fold a low-stock rule in: a week's list is
      the plan and nothing else.
    * **Pantry side** — the rule is `g.is_pantry = 1 AND i.stock IS NOT NULL AND
      i.stock < i.stock_min` (`getLowStockItemIds`, surfaced as `listPantryToBuy`,
      which is DERIVED — nothing is stored for it). Never put a number in that
      SQL: the level is per item (milk reorders at 1, rice at 5), and `stock IS
      NOT NULL` is what separates "there is one left" from "nobody counts this".
    * **The server enforces the boundary** — every pantry write calls
      `isPantryItem()` first and answers 404 otherwise, so no screen can put a
      count on a meal ingredient. Migration `0010_pantry.sql` clears any count the
      earlier iteration left on `is_pantry = 0` items.
    * **A price belongs to the TRIP, not the item** (`pantry_lines`), because it
      says what THIS shopping cost. Pushing the trip clears its prices on purpose
      so a pushed purchase cannot be sent twice, and what the trip became
      (`transaction_id`, `amount`, `item_count`, `pushed_at`) is written back onto
      `pantry_trips` — the Pantry screen's "last trip" reads it, and Sompitra's
      save ADOPTS that expense instead of inserting a second.
    * **A line is a quantity at a UNIT price** (`qty`, migration
      `0011_pantry_line_qty.sql`), and the money that reaches the budget is the
      product summed over the trip. Correcting one half must leave the other
      alone: a write only touches the fields it actually carries.
    * **A price of ZERO is an emptied box, not a free item.** Every reader of a
      line asks `price > 0` (`getPantryTripLines`, the Sompitra hand-off), so a
      stored 0 is a line that draws nowhere while still counting as a row on the
      trip: an "Ar 0" shopping whose hand-off button opens an empty form, which
      nothing can ever empty. Money here is whole Ariary; both doors say the same
      thing (`setPantryPrice` on the server, the row's `commit` on the screen).
      **A typed decimal is CUT, not merged**: `wholeDigits()` in `public/laoka/
      app.js` removes thousands separators and cuts at the point, so "1250.75" is
      1,250 Ariary — the cells are typed, not computed. One helper serves every
      money box (the week's line prices, its debounced flush, the weekly budget,
      the Settings default, the Pantry's unit price and quantity); a fifth copy
      of the old inline strip is how "1250.75" once became 125,075, and smoke §23
      fails if any box keeps its own.
    * **Clearing the prices drops an emptied trip** (`dropEmptyPantryTrip`). Left
      behind, it would draw an "Ar 0" trip on the screen and make the next count
      look like it continued a shopping somebody walked away from. A PUSHED trip
      is never dropped — that row is the identity of a real expense. What counts
      as empty is **the lines that can be DRAWN** (the same rows
      `getPantryTripLines` returns), not raw rows: a line whose item is gone can
      never be shown, priced or cleared, so counting it would keep a trip alive
      that nothing on the screen can empty. That clause also heals rows written
      before the guards below existed.
    * **The pantry owns its CATEGORIES too** — `PATCH /api/pantry/categories/:id`
      (name + icon) and `POST /api/pantry/categories/:id/delete`, both behind
      `isPantryCategory()`. They are deliberately NOT routed through
      `/api/subgroups`: that handler knows nothing about the domain, so a pantry
      write could rename a meal group by guessing its id. Deleting a category
      takes its items AND their `pantry_lines` with it, in that order —
      `getPantryTree` and `getLowStockItemIds` both filter `s.deleted_at IS NULL`,
      so leaving the items would hide counts nobody can see or change, and a
      stranded price would keep a trip alive that draws nothing. **Removing a
      single ITEM does the same thing, one level down** (`deletePantryItem`
      clears its line, and the route then drops the trip it emptied): the two
      paths are one rule, and the item path is the easier one to forget. The
      screen is honest
      about the size of that action (the confirm names the item count), and it is
      the only place a category can be managed at all: the meal Catalog is scoped
      to `is_pantry = 0`, so a pantry category never appears there. For the same
      reason its "Add a type" form no longer offers a pantry group — a group made
      there was invisible in the screen that made it and reappeared as a second,
      meaningless heading on the Pantry tab.
    * **An item is edited ON THE ITEM, never through its category** — each row
      carries its own ✏️ and 🗑, and `PATCH /api/pantry/items/:id` takes any
      subset of **name, category, count and reorder level**. It writes only the
      fields it was SENT (`updatePantryItem`), so renaming an item cannot erase a
      count nobody touched — that partial-write rule is what lets one sheet hold
      four fields. Both boundaries hold on the new fields exactly as they do on a
      count: `isPantryItem` (404), and for a move `isPantryCategory` (400),
      because a pantry item filed under a MEAL category vanishes from every
      pantry list and turns up to the planner as an ingredient. The row's buttons
      must act on the ITEM — a row that edits its category is how removing one
      item takes a whole shelf with it.
    * **The SHAPE of the shelves is on Home** — the dashboard's last card is the
      pantry in one line (items · categories · to buy), and every number comes
      from the pantry's OWN queries (`pantrySummary` → `getPantryTree` +
      `listPantryToBuy`), so a summary cannot disagree with the list it
      summarises. It reads Laoka's database through a DB-scoped env
      (`{ DB: c.env.LAOKA_DB }`) and, when that read throws, says the shelves
      could not be read rather than showing zeros, which would claim an empty
      pantry. The card carries `?tab=pantry`: the shell forwards a plain
      lowercase tab name into the frame's src (`/laoka/index.html?tab=pantry`)
      and the module reads it at boot — the value comes from the address bar, so
      the shell DROPS anything that is not `[a-z]{1,20}` instead of reflecting it
      into that URL.

    Both hand-offs land on the SAME Sompitra form and follow rule 36. Smoke §22
    pins every clause above; `scripts/one-off/2026-09-21-pantry-stock/mutate.mjs`
    runs 52 mutations (§22 and §23, one per guard, ~40 s each) and reports which
    check each one turns red — run it after touching this feature, because a
    guard that cannot go red is decoration. The driver takes ids, so it fits in
    one sitting: `... mutate.mjs M1 M2 …` (52 at once runs well past half an
    hour; targeted ids are the practical way to use it). Most
    mutations edit one clause; where two clauses are redundant on purpose (each
    alone leaves behaviour right) the pair gets its own id through `also` — that
    is the only fault the OUTCOME check can see, and M40/M42/M51 are exactly
    that trio for a removed item's stranded price.

    This batch's own guards (the item editor, the dashboard card, the shell's
    `?tab`) are falsified by `scripts/one-off/2026-09-22-pantry-items/mutate.mjs`
    (11 mutations over §17 + §22). It is the driver that paid for two rules the
    others should copy: it restores every mutation in flight on SIGINT / SIGHUP /
    `uncaughtException` — a run piped through `head` died mid-M9 and left
    `public/laoka/app.js` mutated, which the NEXT run's preflight reported as a
    red guard on a clean tree — and it waits for the dev server to settle after
    writing a file before the section runs, because a fetch landing mid-reload
    returned `/laoka/index.html` without its embed block and turned four §17
    checks red for a reason that had nothing to do with the mutation.
    Its anchors are matched against a **line-ending normalised** copy of each
    file and written back with the ending the file already had: this tree is a
    Windows checkout (CRLF on disk), so a raw `\n` anchor matches nothing. A
    missed anchor changes no code, so it proves nothing: the report names it
    `SKIPPED — anchor missing` per id **and fails the run** (an anchor can go
    stale when its code moves — M10's did, quoting a variable `openPantryExpense`
    no longer ends with).

    Two harness rules the same reasoning produced (2026-09-22): an expected check
    is only evidence if it **ran**, so the driver records every executed check
    name, reports `NOT RUN — <check>` when one never executes (a skipped walk
    reports nothing at all, which used to read exactly like a guard that held),
    and exits non-zero for it; and before touching any file it **preflights** the
    section unmutated, refusing to report at all if an expected check is already
    red or absent. `expects` means *all* of these must go red — M49 named a code
    guard next to the walk check that actually catches its fault and could
    therefore never be caught; the preflight is what made that visible.

    A walk's probe has to make its assertion **mean something**: the quick-save
    walk prices TWO items (3 units, Ar 250) so the count it reads back can only
    be the number of items bought — one item made "items" and "units" the same
    number, and the guard proved nothing while passing.
36. **Laoka hands Sompitra NUMBERS; the household chooses the category.** Two
    doors lead into the budget from one week, and they must stay one behaviour:
    * **The reviewed save** — the export sheet's primary action opens
      `GET /budget/add-expense?from_laoka=<week>`: Sompitra's own form, with the
      week's lines, total and description already in it and the category
      **empty**. That is the point of the form; nothing is written until it is
      saved, and the submit carries a hidden `laoka_week` so the save knows which
      expense this is. Laoka runs in an IFRAME, so the hand-off must set
      `window.top.location.href` — navigating the frame draws Sompitra's form
      inside Laoka, headless, with no way back.
    * **The one-press refresh** — `POST /budget/import-laoka` stays as the fast
      path for a week whose category is already obvious.
    A save that carries a week **adopts** the expense that week already owns (the
    `laoka_imports` lookup) instead of inserting a second one, and both doors
    correct `amount` + `notes` ONLY — never the date, category or description the
    household chose, which is why a stale tab re-submitting this form is safe.
    Both doors write the ledger through `recordLaokaImport`/
    `refreshLaokaExpense`: `imported_at` is the FIRST send and is never rewritten
    (a refresh does not change when the numbers left Laoka), `updated_at` moves
    when the expense is corrected in place, and `category_id` is read BACK OFF
    the transaction rather than taken from whichever submit arrived — a ledger
    that disagrees with the expense it points at is worse than no ledger. Notify
    on `created` only (a correction is not a second purchase). Smoke §22 (e)
    proves the pre-fill, the empty week, the adoption, the no-second-expense and
    the surviving date/category/description; §13 still proves the one-press half.

37. **A number is TYPED, never nudged — one file, every document.**
    `public/shared/number-entry.js` is the only place that decides how a number
    box behaves, and every document Home serves loads it: `views/layout.tsx` and
    `views/shell.tsx` (which between them cover every Sompitra page, the auth
    pages and both module shells) plus a plain `<script>` tag in
    `public/way/index.html`, `public/laoka/index.html`, `public/chat/index.html`
    and `public/live/index.html`.

    It removes the browser's OWN up/down spinner buttons — both engines:
    `-moz-appearance: textfield` for Firefox, and the two WebKit pseudo-elements
    (`::-webkit-outer-spin-button`, `::-webkit-inner-spin-button`) for Chrome,
    Brave, Safari, Edge — and neutralises the two nudges that remain: the wheel
    and the ArrowUp/ArrowDown keys.

    * **The wheel is the destructive one, not the irritating one.** Laoka's
      to-buy boxes commit on **blur**, so scrolling a long list with the pointer
      over a row writes a price for that row: whatever sat under the cursor, at
      whichever quantity the box held — money nobody typed.
    * **`preventDefault()` alone is not the fix.** It protects the box by
      freezing the page, which is the same bug from the other side — Laoka has
      already shipped a list that could not be wheel-scrolled (root
      `overflow-x: hidden`). So the handler cancels the STEP and then performs
      the scroll itself on the nearest scrollable ancestor, falling back to
      `window.scrollBy`. `deltaMode` is normalised first, or a Firefox wheel
      moves the list by 3 px.
    * **An unfocused box is left completely alone.** No engine steps a box that
      does not have focus, so flinging a list past rows you never tapped still
      scrolls — and that exemption is also the guard's own check.
    * **Nothing here rewrites a value**, clamps or validates. Typing, Tab,
      Backspace and Enter are untouched — Enter is how Laoka commits a price
      from the box.
    * **The pantry's − / + count steppers are NOT this.** They are the counting
      affordance for the shelf you are standing in front of, they are deliberate
      taps, and they stay.
    * **A NEW document needs the include**, or its boxes silently go back to
      nudging. Smoke §23 fetches every document and requires the TAG (the string
      alone is not enough: each file also NAMES the module in a comment
      explaining why it loads it — that is exactly how the first version of the
      guard stayed green with a `<script>` deleted).

38. **Module scope is not request storage — a request's data travels as a
    PARAMETER.** One Worker isolate serves many requests and interleaves them at
    every `await`, so a module-level binding that a request WRITES is shared
    state between unrelated people. `src/identity.ts` carried a
    `let lastPassword` exactly like that: set at login, read across several D1
    round-trips inside `ensureModuleAccounts`, cleared in a `finally`. Every
    request was individually correct — which is why it survived review, a rename
    and a merge — and two OVERLAPPING logins could hash one person's password
    into the other's freshly created row. In W.A.Y that hash also IS the μlogger
    Basic-Auth credential (rule 5), so the swap hands one person's phone
    credential to another account.

    * **Reading** module state is fine, and this codebase is full of it
      (`const CONFIG = …`, the column lists, the tab tables). What is not fine is
      a WRITE reachable from a function body: reassigning the binding, writing
      through it (`CACHE[k] = v`, `state.user = u`), or calling a mutator on it
      (`CACHE.set`, `LIST.push`).
    * **Nothing about this class fails a build or throws at runtime.** It needs
      two requests to OVERLAP, so there is no symptom to notice, no error to read
      and no log line to grep — reading the code is the only detector, so it has
      a check instead of a convention.
    * **`ensureModuleAccounts(env, user, password)` takes the password as a
      REQUIRED parameter with NO default.** The login path passes it; the
      auto-repair path passes `null` explicitly. A default would let a later
      caller silently land on the never-create path and leave a person without
      module accounts — the outcome the parameter exists to make visible.
    * **`npm run audit:module-state` answers the question for a person or for
      CI** (read-only, exits 1 on a fault), and smoke §24 holds the same scan
      plus the two controls that keep it honest: it must NOTICE a fault it is
      not currently looking at, and it must NOT report a read-only constant.
      That pairing is the point — a scan whose input silently empties (wrong
      folder, unresolvable typescript, or `SyntaxKind` NAMES compared against
      `node.kind` NUMBERS) reports a green tree forever. That third bug was
      written and caught while building this, which is what the controls are for.
    * **This applies to `src/` only.** Pages under `public/` keep timers, drag
      state and in-flight flags in module scope deliberately: one page, one user,
      one thread — nothing to share.

39. **`this` inside a Durable Object is shared too, one object at a time.** A DO
    is single-threaded, and that is the trap rather than the reassurance: it
    guarantees no two INSTRUCTIONS overlap and says nothing about two REQUESTS,
    which interleave at every `await`. So

        this.currentDevice = body.deviceId   // request A
        ... await ...                        // request B assigns the same field
        use(this.currentDevice)              // A now acts on B's device

    leaks one tracking event's device into another request's turn while looking
    exactly like ordinary object state — no error, no log line, no failing test.
    It is the same family as rule 38, one level down.

    * **State on `this` is not the bug — UNDECLARED state is.** A geofence cache,
      a cooldown map and the daily push ledger all belong on the object and
      would be pointless anywhere else. `DO_STATE_POLICY` in
      `scripts/lib/do-state.mjs` is where each field states its kind and WHY it
      is object state, and §25 fails a new field until somebody writes that down.
    * **A single slot written from a request and read past an `await` is the
      bug.** Keyed state — a `Map` addressed by device, person or event — cannot
      collide this way, which is why those are Maps rather than one field.
    * **`FleetDO.lastNotify` is the one deliberate exception, and it is PINNED
      rather than excused.** It holds request data and is allowed to because it
      decides NOTHING: its registry entry names the single method allowed to read
      it (`fetch`, for the `/debug-notify` payload). A new reader makes §25 red,
      because that is the moment the value starts deciding something and belongs
      in a parameter like any other request data.
    * **A cache must be request-INDEPENDENT by construction.** `geofenceCache`
      and `notifyCache` are refilled from the database and invalidated to null;
      two requests racing to refill one compute the same value, so a lost update
      costs a query and changes nothing anybody can observe. Feed a cache from
      request data and §25 says `wrong-write`.
    * **Scope comes from the bindings, not from the base class.** Laoka's `Lobby`
      is a plain class and a Durable Object all the same, so the audit reads
      `wrangler.jsonc`'s `durable_objects.bindings` — and a class named there and
      missing from the source is itself a finding. A `//` inside a URL in that
      file is why its reader is a real scanner and not a regex.
    * **`npm run audit:do-state`** prints the inventory (every field and its
      declared kind) and exits 1 on any finding; `npm run smoke` §25 runs the same
      scan plus the controls that prove it can still fail (it must NOTICE a
      parked request value, and must LEAVE ALONE honest object state).
    * **The undeclared rule is only as complete as the field set is when it
      runs.** Declarations AND assignments are collected in one pass *before*
      that rule. Collecting an assigned-only field later — `this.recent =
      body.id` in a plain-JavaScript DO, which is exactly what `Lobby` is —
      listed it as `(undeclared)` in the inventory while raising no fault: the
      audit printed "every field is declared" and exited 0 about a class it had
      just called undeclared, and smoke §25 agreed, because both read the fault
      list. §25 now carries a control for that shape (`a field that exists only
      by assignment is reported as undeclared`) and driver M10 reverts the
      ordering (it stops the collection entirely, leaving the same field set
      incomplete at the same point); the real tree stays green under M10, so the
      control is the only thing that notices.

40. **The FleetDO spends 4-5 ROWS WRITTEN on every ping that reaches it, stored or
    not — so the free plan's 100,000 rows/day is spent by the phone's UPLOAD RATE,
    not by how much anyone drives.** Four of them are bookkeeping on any ping that
    arrives, before persistence is even considered: one `sql.exec` for `received`,
    one for `accepted`, one for the outcome (`drawn`/`collapsed`/`paused`), and the
    `device_state` UPSERT. The fifth is the `pending_sync` row, and a drawn ping
    costs one more when the nightly flush deletes it. The pings that never reach D1
    at all — *collapsed*: parked, or inside a fence — are 4 rows each, so
    `gps_pings` shows the journeys and none of the spend; the cost is read from the
    diagnostics ledger instead. That puts the ceiling near **20,000-25,000
    pings/day**, and no amount of pruning moves it: a phone left at a 2 s interval
    with no minimum distance empties it in ~14 hours while parked. `recordingPaused`
    does NOT reduce this (it gates the `pending_sync` row and nothing else), and
    neither does the accuracy or glitch gate, which are counted before they drop.
    `DB-REDESIGN.md` §1c's "comfortable" estimate assumed ONE row per ping per side;
    that is why it was wrong.

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
| Clicking ✏️ / 🗑️ beside one row acts on a DIFFERENT row (Laoka's pantry categories) | a handler built inside a `var` loop closes over the LOOP VARIABLE, so every iteration's callback sees the last one — this shipped once in `renderPantry`, where the ✏️ of every category heading opened “dry staples”. Build the node inside an IIFE bound per iteration (`(function (cat) { … })(sub)`) or hand it to a render function that takes it as an argument (`pantryRow(item)` is immune for exactly that reason). Smoke §22 fails on it |
| A price or a quantity changes by itself while you scroll, or a number box shows up/down arrows again | the ONE place that decides this is `public/shared/number-entry.js`, and every document must load it (rule 37). The wheel must cancel the STEP and then perform the scroll itself — a fix that only calls `preventDefault()` protects the box by breaking the page scroll, which is the same bug in the other direction. Smoke §23 fails if the spinner CSS, either half of the wheel handler, the arrow guard, the "never rewrites a value" invariant, or any document's include goes missing |
| The mouse wheel does not scroll a module (Laoka) | its embed block must not set `overflow` on `html`/`body` — a root `overflow-x: hidden` stops the document being the viewport scroller. `npm run smoke` section 17 fails on it |
| A Laoka tab (History, Settings) cannot be reached in the shell | `#topnav .inner` must `flex-wrap: wrap`; the standalone bar only fits one line at md+, and the shell embeds it at any width |
| A saved recipe reads as one run-on paragraph in **View** (and in a day's gourmet slot), while the editor shows the line breaks fine | the text is stored intact — a browser collapses every `\n` in a div unless it is `white-space: pre-wrap`, and the rule that said so was scoped to `.recipe .ing`, a card that renders no ingredients. The fix is that `.ing` is a TOP-LEVEL rule carrying both the box and `pre-wrap`; re-scoping it silently returns every recipe to a blob. The editor was never evidence: a `<textarea>` keeps line breaks with no CSS at all. Smoke section 17 fails on either half (a parent selector, or a missing `pre-wrap`) |
| The last rows of a Laoka shopping list sit under the export ribbon | `body.with-totals #view` must out-specify the embed's plain `#view` padding — the `!important` on the base rule is what eats it |
| The Sompitra tab icon looks like a blank card | its receipt path relies on winding: body clockwise, the three rule lines counter-clockwise (nonzero rule). Reversed lines fill instead of punching through |
| An inactive tab looks greyed/dead | the colour must come from `--tab` on `.tab-tint` (`CHROME_CSS`); a literal `color:` or a `text-gray-*` utility on a tab is the bug |
| An inactive tab is unreadable in dark mode | `html.dark .tab-tint`'s `color-mix()` lift is missing — without it slate/violet measure 1.9–2.6:1 on the dark bar. It only works if the tint is `--tab` (see the rule above) |
| A card, tile or whole page looks like it belongs to a different app | it is not using `.card` and the surfaces in `CHROME_CSS` — a page's own `bg-white dark:bg-gray-800 … shadow-sm` panel is the bug, not a variation |
| A card title or a caption is hard to read | a token was edited below its floor: `--ink-2` ≥ 6:1 and `--ink-3` ≥ 4.5:1 on `--sheet`, in BOTH themes. Smoke section 26 measures it out of the served values (the retired `gray-400` caption was 2.5:1) |
| A label is back in ALL CAPS | the retired micro-label treatment — `.section-title` is sentence case now, so `uppercase` on any label in a served page fails smoke section 26 |
| Text renders in a system face on one document (the "Home" wordmark is the tell) | that document does not include `CHROME_CSS`: the brand `body { font-family }` rule lives there, not in `<BrandFontLinks />` — which is exactly how the sign-in, claim and change-password screens shipped in Segoe UI while the font request was sitting in their `<head>` |
| The sign-in page is slow to show its mark | `/logo-1024.png` (982KB) is back on the front door; it is `/icons/icon-192.png` (smoke section 26) |
| Nothing on the home screen looks more important than anything else | the anchor/ledger structure was flattened: two `t-anchor`s, or a second `card-lg`, or a row of equal tiles added back beside the anchor (section 26 counts them) |
| A summary of two or three figures reads as a column of text (the Kiné card on Home is the one that has shipped both ways) | the shapes were swapped: a COMPARISON (`.tile`s side by side inside one card) was set as a `.ledger` list, which makes the reader subtract instead of glance. See "A comparison is not a list" above; smoke section 26 counts the week's two tiles in the served page and the three in `KineClientStats` |
| A row of tiles is louder than the card it sits in (coloured boxes where the same figures were ink) | a tile is wearing a colour of its own — `.tile` is the table's paper and a rule, nothing else. The colours this summary has always used belong to the FIGURES: green money in, a balance green / yellow / red, counts in ink. Smoke section 26 fails if `.tile-tint` comes back |
| Half a screen is dark and half is light (a `bg-gray-100` box whose text is invisible) | the tokens are answering a different signal than the `dark:` utilities. They must answer the **`html.dark` class only** — a `@media (prefers-color-scheme: dark)` copy of the tokens is the bug, not the fix (probe it: an element with only `dark:bg-gray-700` is transparent without a `.dark` ancestor, grey-700 with one). Section 26 fails if the media copy comes back, or if a document loads `CHROME_CSS` without the bootstrap that sets the class |
| A tab exists in one shape but not the other | `HOME_TABS` in `views/app-chrome.tsx` is the single list; the bottom bar and `HomeNav` both map over it |
| A person who IS an admin cannot see the admin links on `/settings` (or an admin POST bounces back to `/settings`) | they are a Home admin whose Sompitra row predates the merge, so `users.is_admin` is 0 there. The card and the handlers must judge with `isSettingsAdmin()` — central role first, module flag as a fallback (rule 13, `CUTOVER.md` §1c) |
| The bottom bar shows on a desktop window | the `md:hidden` (bar) / `hidden md:flex` (header nav) split in `app-chrome.tsx` |
| Chrome/Brave on Android never offers "Install app" | `public/manifest.webmanifest` + the icons it points at: each file must exist **at** the advertised size, and the maskable must not be a byte-copy of `icon-512.png` (Android then clips the mark). `npm run smoke` section 16 checks the served bytes. There are **two** installable scopes — `/` and `/way/` (`public/way/manifest.json`, with `public/way/sw.js` precaching its icons) — and section 16 checks both, because the rule was applied to the root manifest only, which is how both WAY icons came to be 1254×1254 files declaring `512x512`: ~2 MB of precached icon per install for a mark a launcher draws at 192 px |
| A low pantry item shows up on the WEEK's shopping list | the two domains are one list again: `syncShoppingLines` must not fold a low-stock rule in (a week's list is the plan and nothing else), and a `.recipe`-style "pantry toggle" coming back into the Shop tab is the same bug from the UI side. Smoke §22 (a) and (f) fail on them |
| A chicken thigh (or any meal ingredient) can be counted | the pantry is no longer scoped to its own domain — `getLowStockItemIds` must filter `g.is_pantry = 1`, `getCatalogTree` must filter `is_pantry = 0` **and** stop selecting `i.stock`, and every pantry write must ask `isPantryItem()` first. A count left on a meal item by the earlier iteration is cleared by migration `0010_pantry.sql`. Smoke §22 (a)+(b) fail on each half |
| The to-buy list misses a staple that IS below its level | `getLowStockItemIds` must compare `i.stock < i.stock_min` (per item) **and** skip `stock IS NULL` — an untracked item is not a zero, and a hardcoded threshold ignores the level the household set. Smoke §22 (a) fails on either |
| An emptied trip lingers as an "Ar 0" shopping on the Pantry screen | four ways in, all pinned: the clear handler must call `dropEmptyPantryTrip` after removing the prices; a price of **zero** must clear the line like an emptied box, not be stored (`setPantryPrice`, and the row's `commit`); removing an **item** must clear its line and the trip it empties (`deletePantryItem` + the route), exactly as removing a category does; and "empty" must count **the lines that can be drawn**, not raw rows — a line whose item is gone can never be shown or cleared, so counting it keeps a trip alive forever. A PUSHED trip must never be dropped — that row is the identity of a real expense. Smoke §22 (d), (d2) and (h) fail on each |
| A price box loses focus, or a half-typed price vanishes, while pricing a trip | a price commits on **blur**, so its reply always lands while the household is already in the NEXT box: rebuilding the list there destroys that box and drops focus to `<body>` (watched happen on the dev server with 1.2 s of latency, which is what a phone has). `pantryWrite(…, { money: true })` therefore repaints only `.pantryfoot` in place and touches no input, and every other pantry write defers while `isTyping()` — the rule `applyState`/`applyRemote`/`softRefresh` already followed. Never "fix" this by re-rendering and restoring focus: the characters typed after the commit are already gone. Smoke §22 (h) fails on it |
| Clicking the pantry hand-off opens Sompitra's form INSIDE Laoka, with no header and no way back | the hand-off must set `window.top.location.href` — Laoka runs in an iframe (same trap as the Laoka export sheet). Smoke §22 (f) fails on it |
| The pantry trip's Sompitra expense is created twice | the save must ADOPT the expense the trip already owns (`pantry_trips.transaction_id` lookup) instead of inserting, and must carry the hidden `pantry_trip`. Both doors then correct `amount` + `notes` only. Smoke §22 pins the lookup in the adoption branch — scoped, because the read-only hand-off builds its own query with the same shape |
| Laoka says a week was "sent" right after refreshing it | `recordLaokaImport` must keep `imported_at` (the FIRST send) and move only `updated_at` on an in-place correction — one door rewriting the first-send time makes the two indistinguishable. Smoke §22 (e) fails on it |
| An expense's date, category or description changed by itself | both doors correct `amount` + `notes` ONLY. The reviewed save deliberately submits a stale date/description and **no** category, and its category is read back off the transaction for the ledger; smoke §22 (e) compares the fields before and after |
| The fence circle on the map does not match where the fence actually triggers | the circle must be **that fence's** `exit_radius_m` (else `radius_m + 40`), read per fence from `/way/api/geofences` — `fenceExitRadiusM()` in the page, with the two fallback numbers mirroring `config.ts`. It was one hardcoded 90 m for every fence, so resizing a fence (production: Home1/Home3/Office2 at 100 m) moved the engine and left the drawing behind. Smoke section 15 fails on a fixed radius, and on fallbacks that have drifted from `config.ts` |
| The Trips month shows no "km walked" while the day card shows one | the month must total through `computeLegsForDay` (geometry, split by classification), the same rule the day uses. Summing each row's stored `distance_km` **cannot** work: walking rows are stored with distance 0 on purpose, so that figure is 0.0 km for every month, for everyone. Smoke section 15 fails if `loadMonthlyTotals` reads a per-row distance again |
| The HUD badge and the Trips card show two different distances for one day | the HUD must **recompute** its "km today" from those same rows (`refreshTodayDist` → `computeLegsForDay`), never accumulate each ping's stored `distance_km` as it arrives. The two are different quantities, not the same one rounded: local data read `1.8 km today` on the badge against `0.9 km` on the card for one day. Smoke section 15 fails if a `todayDist[...] +=` accumulator comes back |
| The day after a walk is charged the walk as driven km | a walking return in `computeDriving` must also advance `lastRecordedPoint` — that anchor is where the NEXT driving segment measures from, and leaving it at the last driving point makes a walk-to-the-shop-and-back part of the drive home. The row still stores distance 0 on purpose; the anchor is a separate thing. Smoke section 15 counts both walking returns, and `scripts/one-off/2026-09-21-walking-anchor/probe.mjs` proves the arithmetic on the real state machine |
| A reviewed past day draws a walking leg like a drive, or a walking day exports an empty GPX | `showDayOnMap` breaks its lines at a change of MODE too (walking = `walkingLineStyle`, thin + dashed), and `exportCurrentDay`'s GPX keeps every point `shouldDrawPoint` keeps, one `<trkseg>` per run. The GPX used to filter `is_driving`, so it disagreed with the CSV and the KML on the same row of buttons. Smoke section 15 fails on both |
| The bar under the map shows a crossing the pill never drew | the page must have **one** verdict function (`meetDecision`) that both the live pill (`meetEtaFor`) and the distance gauge (`renderMeetStrip`) call, and the bar's green name + red tick are asked about the bar's **OWN two ends** (`meetStripCrossPair`), which while a reference is picked can be a pair the pill is not talking about — a tick borrowed from the pill's pair would mark a bar whose dot is somebody else. Both sides also start from one participant test (`meetParticipantVelocity`: driving, and fast enough), so they cannot disagree about who is in a meeting at all. Smoke section 15 fails if the gauge grows its own copy of the gates |
| The bar measures to the wrong thing, or the list of people and places is unreachable | the name on the bar is the **picker**: it opens every other person and every place, **nearest first from the device being watched**, and the pick is **persisted** (`map_strip_ref`) and **deactivate-able** (the Auto row, or tapping the lit row again). A pick beats the pill's peer and beats the nearest one — that is the whole point of picking: the distance is then allowed to GROW as well as shrink. An unresolvable pick (a peer that has not reported since the reload, a place that left the list) still draws, with `dist: null` and the reason in the title, and the bar stays visible even when nothing has a position: it is the only way into the picker, so hiding it hides its own control. Smoke section 15 runs `meetStripTarget` (pick beats nearest, and beats the pill's peer), `stripPickerRows` (order + which row is marked) and checks the persistence, the delegated row click and the panel's own markup |
| The bar's arrow points the wrong way, or disagrees with the pill | the trend chevron is the **range rate** between the bar's two ends — the same `rangeRateKmh` the verdict gates on (`closing < MEET_ETA_CLOSING_MIN_KMH`), so a bar that says "closing" cannot be showing a pair the pill has just called off — with a `MEET_STRIP_TREND_KMH` noise floor, `flat` in between, and **null** (no arrow) when the map has no honest velocity for one of the two ends: a stale distance is still a reading, a stale direction is not. A place has no velocity of its own, so its rate is your own motion along the line to it. Smoke section 15 evaluates the rate (at / away / head-on) and fails if either caller stops sharing it |
| The bar fills up as the two of them move APART | the fill is what is **LEFT of the current scale** (`meetStripFillFraction`: `1 - dist / scale`) — the FAR end of the scale is on the left and "here" is on the right, so the bar grows as they close and drains as they part, and one glance answers approaching-or-separating before any number is read. It was drawn the other way round first (fill = the distance), which made a widening gap look like the bar filling up. Every mark on the track goes through that one mapping, and the dot rides the fill's head, so the shading, the mark and the number beside it cannot disagree. Smoke section 15 walks the fraction out from 0 to 1 km of a 1 km bar and fails if it is not monotone DOWN, or if 0 m is not the full bar |
| The bar's scale flickers, or its dot says nothing about how far apart two people are | the gauge is a **ruler with a moving scale**: the rung is the smallest one that still contains the distance — a ladder BUILT from `MEET_STRIP_BANDS_M` (200 m steps under a km, then 1, 5, 10, 20, 50 km, then 100 km up to the ceiling) — and it is named on the bar, so `1.2 km` beside a `2 km` bar is a bar 37% full. The remembered rung belongs to ONE **subject** (`meetStripScaleKey`): switch the bar from a 12 km pick to the place next door and it starts fresh, instead of walking down one rung per fix while drawing 150 m as 2% of a 20 km bar. The scale grows the instant the distance outgrows the bar and shrinks only under `MEET_STRIP_SHRINK_AT` of the next rung down; the reluctant half is load-bearing, because ±6 m of fix noise crosses a 200 m boundary repeatedly. A rescale therefore STEPS the fill — down to a quarter when closing, up to a half when parting, on the fine rungs — at the same moment the scale label changes: the price of a bar that always means "of the scale shown", and the reason the exact distance is printed rather than implied. Smoke section 15 pins the bands literally and runs the builder over the real rung boundaries |
| The bar's colour means nothing, or goes amber at every range | the fill and the dot are tinted by how far the distance sits **into the current rung** (`meetStripCloseness` → `meetStripTint`, green at its floor to amber at its top), not by real distance — 2 km reads green on a 5 km bar and amber on a 2 km bar. Deliberately a *different quantity* from the fill: keyed to the whole scale the colour would barely move, because hysteresis keeps the distance in the top half of its scale at every real range, so it would be amber at 500 m and amber at 50 km; keyed to the rung it sweeps the whole ramp on every rung and still moves with the fill (green as the bar grows, amber as it drains). Smoke section 15 evaluates the ramp and fails if the input changes to something that cannot move |
| The bar shows a place instead of a person, or the setting for it does nothing | the bar's source is a persisted setting in **Settings → Map** (`map_strip_source`, the same control shape as the pace switch): nearest person, or nearest place. Place mode measures straight-line to the fence **centre** and must carry **no direction test** — "Heading toward X" is about which way you are pointed, and a ruler that hid a place behind you would not be a ruler. A place also has no crossing, so the red tick and the pill-coloured label stay off. Smoke section 15 fails if place mode grows the pill's 55° cone, loses the setting, or starts counting down a meeting with a fence |
| The bar goes blank on a peer whose last fix is old, or shows a stale pair as if it were live | the gauge and the pill differ on exactly one thing, deliberately: a distance reading is still true when it is old, a promise about the next few seconds is not. So the gauge **still draws a stale peer and prints the age beside it**, while `meetDecision` keeps the pill dark. Smoke section 15 fails if the gauge starts bailing on staleness instead of labelling it |
| The map announces a "meeting" for two people on parallel roads, or for a pair two kilometres apart | the meeting pill's gates, all three of them priced in `scripts/one-off/2026-09-24-meet-eta-lab` rather than by eye: each velocity comes from that device's **own last two fixes** (never the reported speed column, which would otherwise be believed twice), the estimate is ignored beyond `MEET_ETA_SETTLED_M` (at 2 km, ±6 m of fix noise swings the predicted miss by hundreds of metres — the lab's first false positive was a 39 m "meeting" between two people who passed 464 m apart), and the miss distance `MEET_ETA_DCPA_MAX_M` plus the 55° heading test are what separate a crossing from two people pointed at each other on roads that never meet. Smoke section 15 fails on each |
| The pill goes dark in the MIDDLE of a real meet | the fence rule must count a peer inside a fence as **home only if it is also not moving** (`theirs.fix.is_inside_geofence && theirs.kmh < CONFIG.ETA_MIN_SPEED_KMH`). Requiring *both* peers to be outside every fence silenced 15 s of a true meet, because every driver is inside their own home fence for the first minute of a trip — measured on the lab, which prices both readings in a table. Smoke section 15 fails on the stricter test |
| The HUD promises an arrival that never pushes, and the badge never pulses | the HUD's `ETA_MIN_SPEED_KMH` / `ETA_MAX_BEARING_DIFF_DEG` and the DO's `APPROACH_MIN_SPEED_KMH` / `APPROACH_MAX_BEARING_DIFF` are the same judgement made twice, in two languages, and they must be equal — smoke section 15 compares the four values |
| A WAY or share page loads blank, but the server answers 200 with the full document | a syntax error in that page's inline `<script>`. Nothing compiles these files (by design — no build step), so it reaches production silently: the only compile either page gets is smoke section 15, which parses both inline scripts with `node:vm`. The old header named a `check:dashboard` script that exists only in the standalone W.A.Y repo |
| "Is my tab stale, or is the deploy broken?" cannot be answered | `WAY_BUILD` (bottom of Settings) is the only answer, so it must be bumped with the page: smoke section 15 fails when the marker's date is older than the last commit that touched `public/way/index.html` (skipped when git cannot answer, e.g. a shallow export) |
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
| The badge reads `0 km/h` while the HUD beside it says `-- / No signal` | a NULL speed is not a zero one, and the badge used to run it through `|| 0` — so a ping the intake **discarded** (rule 25: a report above 120 km/h) printed the one number in that row that means "parked", on a device the same row had just called driving. It prints `-- km/h` now and smoke §9b fails if the `|| 0` comes back. The usual trigger is a hand-fed track: μlogger reports `speed` in **m/s**, so `speed=84` is 302 km/h and is thrown away (`speed=23` is ~83 km/h) |
| A device's track teleports, or a synthetic ping seems to be ignored | the **position** half of rule 25 — `isGlitch` drops a ping implying >120 km/h silently and the upload still answers success. Check the speed your test generated before suspecting the pipeline (a 5 s gap and a 1 km step is 720 km/h, no matter what the `speed` field says) |
| A save or a chat message "did nothing at all" | the network path, not the server: `apiJson` answers a rejected fetch as `{ok:false, status:0}` so the caller's alert runs, and the chat composer clears only after `sendWs` returns true — smoke sections 15 and 12 fail if either goes back to silence. DevTools' Offline switch reproduces it in one step |
| "Did the tracking rules actually do anything?" after a real-world test | `/admin/diagnostics` (admin-only). It is the ONLY way to tell "the phone was correctly filtered" from "the phone never uploaded" — every gate drops silently by contract (rule 30). Read the sums first: `received = accuracy + glitch + accepted`, `accepted = drawn + collapsed + unwitnessed + paused`. `collapsed` climbing with `drawn` flat is a parked phone working as designed, not a broken pipeline |
| `/admin/diagnostics` shows no gates at all | the counters are **DURABLE and build-scoped**, so exactly three things empty them: a fresh deployment, a **build-marker bump** (`ensureSchema` clears them when `DO_BUILD` changes), or the **Reset counters** button. A restart or an eviction does NOT — so if a restart seems to have cleared them, the code changed too. An empty list right after a deploy is normal; send one upload and they reappear. If it persists with `"ingest": null`, the FleetDO binding or `/debug-notify` is the problem (rule 30) |
| The share link says the code has ended, or the viewer's map is blank | first the easy half: `expired`/`revoked` (410) means the grant is spent — midnight UTC passed, or an admin revoked it — while `bad_pin` (400) means the code is simply wrong. A blank map with a 200 is the DO half: `GET /way/api/debug/notify` must report the build CUTOVER.md's post-deploy step names, because an instance older than `notify-v15-share-window` 404s `/share-state` and the page then honestly says it has nothing (rule 31) — and a **v14** instance is the subtler failure: it answers 200 while IGNORING the window, so the viewer sees points from earlier today |
| `/live` asks for a code and nothing is listed in `/admin` | `migrations-home/0006_share_links.sql` was never applied to THIS database (local or remote). `listShares` swallows the missing table on purpose, so the card is empty rather than broken — the console's own silence is the symptom |
| A notification vanished last Tuesday and nobody can say why | `diag_events` in **home-db** (`/admin/diagnostics` → Notification ledger). It holds every push that did NOT reach a phone, with ntfy's own words. Rows expire after 90 days (the daily cron's prune), and `ledger.total: 0` means every push has been landing. If the ledger is unreadable, migration `migrations-home/0005_diagnostics.sql` was never applied |
| A ping with a silly accuracy (say 50 m) still moves the dashboard | the gate is the FIRST thing in `FleetDO.handleIngest` (rule 29) — check `accuracyIsAcceptable` is still called before the speed filters and still reads `PRE_FILTER_MAX_ACCURACY_M` from config. And note the other direction: a client that sends NO accuracy always passes by design (null is accepted), so first check whether the field was sent at all |
| A track spikes out and back from a geofence while the phone is parked | two separate causes, and the rows tell them apart. **Same-second pair?** judged against `GLITCH_TIME_FLOOR_S`, never skipped (rule 27) — a pre-floor DO accepts it unseen. **First row of the pair exactly on the exit radius?** that is the guard's interpolated edge point, so read the ping that STARTS the exit: a far-out ping after a long silence passed every speed gate (0.5 km/h implied over hours) and the guard then confirmed on wall time. `pingsFlushed` counts only accepted pings, so it is the first honest number to read |
| Sompitra notifications arrive but W.A.Y's don't (or to the wrong topic) | the FleetDO's `getNotifyConfig()` channel lookup + its cache: `GET /way/api/debug/notify` shows the exact topics and server it resolved |
| A phone gets nothing at night, but chat still arrives | **not a bug** — quiet hours (way-db `users.quiet_start`/`quiet_end`, 22–06 by default) mute every tracking event except chat. The 📍 card in `/settings` states the window and whether it is on now |
| Someone is ticked in W.A.Y's grid and still receives nothing | they have no **tracking** topic: the grid says yes, the events are addressed to a topic that does not exist, and nothing else complains. `/settings`' household card warns about exactly this, and `GET /way/api/debug/notify` reports `Niri has no topic` |
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
| A phone's uploads to `/ulogger` are rejected (401), or `addpos` says "Missing required parameter" | device auth **folds case** on `users.username` (`MaxX`, `Niri`), so a 401 means the password (not the casing) is wrong, or a session cookie went stale — and `addpos` wants `time` (seconds), not `timestamp`, with `speed` in **m/s** (the route converts to km/h). Before 2026-09-20 this check was exact-case, which is how a casing fix could leave a phone refused while the browser login worked (rule 33) |
| The share's map is blank, or shows "access blocked … tile usage policy" (`osm.wiki/blocked`) | the page is pointing at a tile server of its own again. Both maps read `/shared/basemaps.js` and nothing else, because OSM's volunteer-run server blocks this app per-APP (the same request with no `Referer` still gets a real tile, which is why `curl` looks fine): a blocked tile is a **flat 1-bit image a few hundred bytes long**, not an HTTP error. Never inline a tile URL in a page — that is how `/live` broke while the household map, on Esri, looked perfect |\r\n| A tile lands in the wrong part of the world, at the right zoom | Esri's tile path is `/tile/{z}/{y}/{x}` — ROW before COLUMN, the reverse of OSM's `{z}/{x}/{y}`. Copy a basemap from `/shared/basemaps.js` instead of retyping a URL; smoke §9 asserts the order |
| The share opens too far out to read a street, or at a zoom the tiles cannot serve | the viewer's follow zoom is ONE number, `FOLLOW_ZOOM` in `public/live/index.html`, used by the first `setView` and by Recentre. Smoke asserts `16 ≤ FOLLOW_ZOOM ≤ streets.maxNativeZoom` (a level past the raster's native zoom returns the last real tile upscaled: the map looks fine and is wrong) and that neither call site names a zoom of its own. It is NOT the household map's `FOLLOW_ZOOM_LEVEL`, which is a per-person preference there |
| The share's map looks empty at street level, with no error anywhere | not a block and not a bug: Esri's street raster carries little detail at z17 over rural Madagascar (~2.4 KB per tile against ~6.5 KB at z14, both genuinely served). Read the tile BYTES before concluding a host blocks you, and do not answer this by pointing at another tile server — a second hand-typed tile URL is exactly how `/live` got blocked (see the two rows above) |
| A page you just edited still behaves the old way in the Preview tab | the browser is holding the DOCUMENT, not the file: `wrangler dev` serves the current bytes (verify with an authenticated `curl`, an anonymous one only 302s to `/login`), but a preview already showing `/way/` keeps running the script it loaded. Reload the page (or navigate the preview away and back) before concluding a fix did not work — and treat a `sessionStorage` pin as sticky across in-page hash changes |
| A route answers a bodyless 500 and the page can only say something generic | a throw ABOVE the named-error layer is not caught by it: `requireUser` reading D1, or the identity lookup that runs before `lib/share.ts`. `handleWay` wraps both API groups and answers JSON with a sentence, logging the route — observed for real on `POST /api/share` (2026-09-21). Smoke asserts the wrapper is still there |\r\n| Pings start arriving under a spelling you just merged away | the running build is older than rule 33: the device id must be **re-resolved from the account** on every fix (`canonicalDeviceId` in `src/way/routes/ingest.ts`), because a 30-day μlogger cookie minted before a rename re-stamps the old spelling onto `gps_pings.device_id`. Smoke §19 forges exactly that cookie and reads the ledger row back |
| The share badge shows the speed but NOT its colour, and the footer/address stay empty or frozen | a local named **`window`** inside that function. `var window = state.since ? …` was hoisted to the top of `render()`, so the global read `undefined` for the whole function and every statement *after* the speed figure was silently skipped — on every poll, forever, with nothing in the console but `Cannot read properties of undefined (reading 'HomePlayback')`. The local is `windowLabel` now, and section 20 fails any page that declares its own `window` |
| The share button is missing from WAY → Settings → Map | first check WHO you are signed in as: the row is admin-only, and a non-admin sees the sentence "Only an admin can hand out a code" in its place. If you are an admin and it still says **Checking…**, the device list has not loaded — the row acts on the SELECTED device and refuses to show a stale answer for a different one. A `403` from `POST /way/api/share` while `/admin` mints fine means `shareMinter` is failing to read the central session: `HOME_DB` must be bound and `home_session` must be present (the console uses the same cookie) |
| A code minted from the map is not listed in the console | both doors write the same `share_links` rows, so an empty console means the row is not there at all: check `wrangler d1 execute HOME_DB --local` for `SELECT id, subject, revoked_at, expires_at FROM share_links`. Note the console lists ACTIVE codes for every device while the map shows only the SELECTED device's |
| The share's dial is grey while the digits are correct | the viewer's browser is holding `/shared/playback.js` from an older deploy (the preview pane did exactly that). The lookup is guarded, so a missing `speedColor` costs only the COLOUR — never the address and the window lines. A hard reload takes the new engine; the served file itself is checked by smoke (`SPEED_STOPS` + the four stops) |
| The WAY marker is 25 s behind the device, or the map keeps moving | **not a bug** — the viewer draws on a delayed playback cursor and a follow camera that cycles on purpose. The HUD stays live, and the lag is named by the one blue line under the pace pills in **Settings → Map** (shown on Smooth, removed on Live). If you need the newest ping now, switch the pace to **Live**. See `project.md` → "The W.A.Y map is drawn on a playback clock" |
| The map drifts while the device is clearly inside the circle, or the device is left sitting at the edge after the camera moves | the follow cycle is DRIFT (map **still** while the device roams `FOLLOW_ZONE_DIAMETER_FRACTION` of the shorter side) → PUSH (map still for `FOLLOW_PUSH_MS` while the device shoves past the edge) → PULL (swept to the **opposite** edge, timed at `FOLLOW_PULL_RATIO` of the drift just watched). A camera that moves during the drift, that lands near the **middle** instead of the far edge, or that takes a fixed time regardless of speed, means `updateFollowCamera` was changed: smoke section 15 asserts all of it, that the sweep drives a live offset (`panBy`, never `panTo`/`setView`), and — by evaluating `pullEase` — that it overshoots its aim slightly on the way |
| The map keeps pulling, over and over, on a device that is standing still just outside the circle | the sweep must come to rest just INSIDE the circle (`FOLLOW_PULL_LANDING` = 0.93). At exactly the opposite extreme the device is still outside on the frame the pull ends, so the trigger fires again on the next frame and it loops forever — one degree of hysteresis is what ends it |
| A page you changed still looks old on a phone — the deploy is fine, the number did not move | first check WHICH build the phone is on: **WAY → Settings** prints `build 2026-09-19.6-superapp` under Log out (the marker only bumps when the WAY document itself changes). Each tab is a **fresh server-rendered page**, so switching tabs (or reopening the installed app) reloads it — but a tab that was already open through the deploy keeps its old document until you do. Assets are served `must-revalidate`, so it is never the HTTP cache. This is how the HUD's size change looked like it had not shipped: it had, and on a ≤420 px viewport it is only 33 px vs 30 px (the larger 42 px branch starts above 420 px, which is why a phone and a 423 px iframe render differently) |
| The HUD/speed readout is smaller than the desktop screenshot | `.spd-num` is 42 px, and the `@media (max-width: 420px)` block in `public/way/index.html` drops it to 33 px with a 138 px card — a 1 px width change across that boundary is a 9 px jump. Change the branch, not the desktop value, when tuning for phones |
| A cached page appeared for the wrong account, or an offline load showed a signed-in screen | a service worker cached a DOCUMENT. There are two (`public/sw.js` at `/`, `public/way/sw.js` at `/way/`) and the narrower scope wins for a /way/ URL, so both must keep the assets-only policy: no page in the precache list, and `req.mode === 'navigate' || req.destination === 'document'` returns before any cache is consulted. A policy change must also bump the cache name — that is what evicts the old entries. Smoke section 16 fails on both files |
| A Kiné payment does not show up as budget income | the sync resolves its account (`kineIncomeAccount` in `src/routes/kine.tsx`): the signed-in person's own account whose name starts with `Kin%` first, then any `Kiné Privée`. No such account → the "Sync to Budget Income" checkbox is not even offered. It used to look for `username='niri'` specifically, which quietly broke the feature for anyone else |
| The device emoji sits ON the position dot, so the dot — the thing that says moving / stationary / slow — is nowhere to be seen | the icon is a LABEL, not the position: the 14 px `placeTip` dot is the trail head and carries the point, and the Settings emoji floats `CONFIG.MARKER_BOX_PX - CONFIG.MARKER_GLYPH_PX` (32 px) above it inside a taller icon box anchored by the box's bottom edge. If the two are fused, `iconSize`/`iconAnchor` were set to the glyph's own size (`[30, 30] / [15, 30]`), or `MARKER_BOX_PX` was pulled down to the glyph's height — smoke section 15 fails on both, and on the second layer drawing the dot from anywhere but the playback clock's `placed` position |
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
| A login briefly shows or provisions another person's account (or a module row appears with the wrong password) | module-scope state carrying REQUEST data — rule 38. `npm run audit:module-state` reads every file under `src/` and names the binding; smoke §24 fails on it. The one that shipped was `let lastPassword` in `src/identity.ts`, and the wrong value lands in the WAY/Laoka row a person is CREATED with, which in W.A.Y is also their μlogger credential |
| A tracking event acts on the wrong device, or one request's data appears in another's | request data parked on the DO's `this` — rule 39. A field assigned from a request and read past an `await` is shared with whatever request interleaves; `npm run audit:do-state` names the field and its kind, and smoke §25 fails on it. The one field allowed to hold request data (`FleetDO.lastNotify`) is declared `diagnostics` and may only be read by the method its registry entry names — a new reader means it has started deciding something |
| `npm run audit:do-state` lists a field as `(undeclared)` and still exits 0 saying "every field is declared" | the undeclared rule ran before assignment-only fields were collected, so the field set was incomplete when it was tested — rule 39. Both the command and smoke §25 read the fault list, so both agreed on the wrong answer; the §25 control `a field that exists only by assignment is reported as undeclared` is what notices, and driver M10 reverts the ordering to prove the control is the thing holding it |

### What is actually served

The assets binding is `./public` **only** (`wrangler.jsonc`). W.A.Y's live
document is `public/way/index.html`; Laoka's is `public/laoka/index.html`; the
chat's is `public/chat/index.html` and the one public page in the app is
`public/live/index.html` (served through the Worker for its `noindex` header —
never linked, never session-gated).
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
