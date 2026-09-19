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
Tab icons are the real assets (`/icon-64.png`, `/way/icon-64.png`,
`/laoka/icon.svg`) plus inline SVG for the shell-native tabs — never emoji,
which render as blurry colour glyphs and cannot inherit the active tint.
Sompitra's is a **receipt** (a slip with a torn bottom edge and three rule
lines), not the wallet-ish card it started as: at 24px a card reads as "a
card" and says nothing about expenses, while a receipt is legible at 20px with
no colour at all and cannot be confused with the house / bubble / pot / pin /
person around it. Its three rule lines are **holes punched by winding** — the
body runs clockwise, each rule counter-clockwise, per the nonzero fill rule;
reverse either and the lines silently drown in the fill.

**Two shapes, one list, one colour rule.** Below 768px the navigation is the
bottom bar; from 768px up the *same* six tabs are laid out horizontally in the
header (`HomeNav`) and the bar is hidden — a phone bar pinned to the bottom of
a 1280px window is the biggest "this is a phone page" tell. Both shapes map
over `HOME_TABS`, so a tab cannot exist in one and not the other (`npm run
smoke` asserts both carry the same six). Each tab wears **its own colour
whether or not it is active** — green Home, teal Sompitra, violet Chat, orange
Laoka, sky WAY, slate You — because the six modules are meant to be readable
by colour alone; selection is carried by the 26px marker above the icon, a
10%-tint pill and a bold label, i.e. shape and weight, never hue.

The tint travels as the `--tab` custom property rather than a literal `color:`
for one reason: **contrast**. On the dark bar the raw tints measure 1.9:1
(slate You) and 2.6:1 (violet Chat) at label size, so `html.dark .tab-tint`
lifts them toward white with `color-mix()` (measured 4.7–7.5:1 after the lift,
5.3+1 at full opacity). On white they are used as-is and the inactive dim is
deliberately *not* applied — those brand hexes are already at their ceiling
(2.9–7.6:1), and dimming them further is exactly the "inactive tabs fade out"
look the colour rule exists to prevent. `<meta theme-color>` follows the active
tab, so the browser chrome and an installed app's status bar match the module
you are in.

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

  **The embed must not touch the module's scroll container.** Laoka's embed
  block deliberately sets *no* `overflow` on `html`/`body`: an `overflow-x:
  hidden` on the root element is a documented way to stop the document being
  the viewport scroller, which loses **mouse-wheel scrolling of the whole
  page** — and it was only ever there to hide a symptom (six nav buttons
  overflowing a phone-width frame, clipping History and Settings). The real
  fixes are the ones in that block: the nav **wraps**, nothing in the app is
  wider than a phone, the nav stays **sticky** under the 46px header (the
  shell owns the bottom nav, so this row is the only way between Laoka's six
  tabs), the fixed totals/export ribbon moves to the frame's edge, and
  `body.with-totals #view` reserves room for it — at the embed's own
  specificity, or the plain 16px rule wins and the last rows of the shopping
  list sit permanently under the ribbon. `npm run smoke` section 17 asserts
  all five.
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
* **That one chat is also the app's activity feed.** Because the chat is the
  only place the household already looks, every module reports into it as a
  system message rather than each growing its own notification list. WAY's
  geofence transitions (`arrived` / `left`) are written by the DO itself, and
  Sompitra's money events (`expense` / `income` / `kine`) arrive through the
  DO's `/system-chat` intake, posted by `src/way/system-chat.ts`. So the
  scrollback reads as one story — "📍 MaxX arrived at Home" next to "💸 MaxX -
  Expense · Ar 45 000" — instead of the finance events being invisible to the
  person who is not looking at the Budget tab.

  **Money in and money out are separate event types, not one "a transaction
  happened".** The chat colour-codes them the way Sompitra's own UI already
  does (`red` \- for spending, `green` \+ for income), so a salary landing is
  not mistaken for an expense while scrolling. The split runs all the way
  through: `NotifLine.kind`, the DO's allowlist, the event type written to the
  chat row, and the page's `AUTO_STYLE`. The single `budget` type that existed
  before the split is still *rendered* (as an expense) so rows already written
  keep their meaning, but nothing posts it any more.

  The rules that keep this honest:
  * System rows are always `is_auto` with `sender: null` ("System" once
    flushed to D1, whose column is NOT NULL). A system message can never
    impersonate a person, and a person can never post one: the intake is
    reachable only through the DO binding, not as a public route.
  * The DO allowlists the event types it accepts from other modules
    (`EXTERNAL_SYSTEM_EVENTS`, reported live by `GET /way/api/debug/notify` as
    `systemChatEvents`), and the chat page styles each type (`AUTO_STYLE`) with
    a neutral fallback, so a type added on one side only degrades to a plain
    bell pill rather than a bubble from nobody.
  * Mirroring into the chat is **independent of ntfy**: no push server and no
    per-person channel are needed for the household to see activity in the
    app. ntfy is for reaching someone who is not looking; the chat is the
    record.
* Sompitra (budget/kine/debts/sales) is one tab with its own sub-nav, shown at
  **every** width — it was `hidden sm:block`, which left Kiné, Debts and Sales
  with no route from the Sompitra tab on a phone, where most of this app is
  used. `/settings` is the You tab; `/admin` stays a Sompitra-style page.

## The brand system (one typeface, one accent per screen, brand glyphs)

The chrome is shared; this section is about what makes a screen *look* like it
belongs to the same app. Every item below was a real "is this one app or three?"
tell that survived all the functional work, because none of it is visible to a
test that only reads behaviour.

**One typeface.** `BRAND_FONT_STACK` (app-chrome.tsx) is loaded by every
document we serve, via the shared `<BrandFontLinks />`: the Sompitra pages, the
module shells **and** the sign-in / claim / change-password screens. Before
this, W.A.Y shipped Plus Jakarta Sans while Sompitra, Laoka and the chat room
shipped Segoe UI — the same person could see two typefaces in two tabs, which
is the loudest possible signal that they are separate apps. The system stack
stays behind the brand family as the fallback, so a cold cache or a fully
offline PWA still renders in a real face instead of a serif default. Money uses
`.num` (`font-variant-numeric: tabular-nums`): proportional digits make
`Ar 7,500` and `Ar 12,300` different widths, which is exactly what makes a
column of amounts look hand-scattered.

**One accent per screen, taken from the tab you are in.** `HOME_TABS` carries
two values per module (app-chrome.tsx):

| Module | `color` (tint) | `ink` (filled surface) |
| --- | --- | --- |
| Home | `#16a34a` | `#166534` |
| Sompitra | `#0d9488` | `#0f766e` |
| Chat | `#7c3aed` | `#6d28d9` |
| Laoka | `#ea580c` | `#c2410c` |
| WAY | `#0284c7` | `#0369a1` |
| You | `#475569` | `#334155` |

The layout and the module shells set both on `<body>` (`--accent`,
`--accent-ink`) from that one table, so a page cannot disagree with the tab that
got you there: the card-heading glyphs (`.accent-mark`), the section headings on
`/settings`, the money sub-nav's active pill and the 2px hairline under the
header all read those variables instead of hard-coding a hue. Two rules come out
of the table:

* **`ink` for anything filled with white text.** The tint is too light for a
  filled surface — white on `#0d9488` measures 3.9:1 — so a filled control uses
  the same hue one step down (white on `#0f766e` is 5.3:1). Using the tint as a
  button background is a contrast bug, not a shortcut.
* **Dark mode lifts the tint.** `html.dark .accent-mark` mixes `80%` of the
  accent with white; measured on the `#1f2937` card surface the six accents land
  at 3.2–5.7:1, above the 3:1 floor for graphical objects. Slate You is the
  worst case and the reason the lift exists at all (raw slate is 1.9:1, i.e.
invisible). Icon size is why the standard here is non-text contrast: these are
  marks, not labels, and the heading *labels* stay grey on purpose — tinting
  11–12px text is how a heading becomes unreadable in dark mode.

**Brand glyphs, not decoration emoji.** `ICONS` / `<Icon>` in app-chrome.tsx is
the app's own glyph set (~25 shapes), and card headings take an `icon` prop
(`<Card title="Cash Flow" icon="trend">`). This replaced the emoji that were
glued onto nearly every title (🔔 👐 💰 📋 🎯 …), for three reasons: an emoji is
a colour picture the OS chooses, so it cannot wear the screen's accent and never
belonged to the module it sat in; it changes size and baseline per platform; and
it cannot inherit a tint. Emoji that **encode** something — the 🟢🟡🔴 Kiné
legend, category icons, the per-user colour dots — are data, not decoration, and
stay. Several glyphs rely on winding the same way the Sompitra tab icon does: a
sub-path running against its parent punches a hole (the donut, the target rings,
the padlock's shackle, the server's status lights, the pin's centre).

**The palette means something.** On the money screens: **green = money in,
red = money out, teal = a period's net result, orange = we owe, purple = owed
to us** (teal is Sompitra's own hue). Income used to be blue in the summary
tiles while the same income printed as `+Ar 45,000` in green in the list below
it — one fact, two colours, one screen — and the same disease was still present
later in three places: `/budget/reports` and Sales printed a positive result in
blue, the Debts page printed credit (owed to us) in blue while the dashboard
printed the same money in purple, and a credit's amount on the dashboard
printed in orange, the "we owe" colour. Smoke section 18 now reads the served
pages and fails on any of them.
Two deliberate exceptions, both stated so they do not look like drift: **cash
on hand is graded** by `currentGradedTone` (red under zero, then yellow, blue,
green as the balance grows) because it answers "is this healthy?" rather than
"which way did the money go"; and **Kiné's tiles keep Sompitra's original
colours** (delivered blue, paid orange) because they count sessions and
payments, not the direction of money.

**The module stage.** WAY, Laoka and Chat run inside
the `#home-module-stage` → `#home-module-frame` frame (shell.tsx): inset 8px
(12px from `sm` up), rounded 16px, with a hairline ring instead of a shadow
edge. A module that bleeds to all four window edges reads as a separate app the
chrome happens to sit on — the Chat tab was a black room jammed under a white
header, one hard seam and no shared edge. The inset makes it a panel *of* Home,
the way a mini-program sits inside its host, and the ring is the panel's edge in
both themes.

**The trap this all rests on:** a grid item's automatic minimum size is its
*min-content* width, and a transaction description is rendered with `truncate`
(`white-space: nowrap`). One long description — a Laoka import reads "Laoka
shopping 2026-09-12 – 2026-09-18" — therefore widens the whole page past a
422px viewport and the phone gets a horizontal scrollbar. `min-w-0` has to be on
the element that **is** the grid item, not only inside it. `npm run smoke`
section 18 guards that, the one-typeface rule, the accent-equals-tab rule, the
glyph-not-emoji rule and the stage.

## Installable (PWA)

Home installs from Chrome/Brave on Android and then behaves like an app:
`public/manifest.webmanifest` (standalone, `start_url`/`scope` `/`, shortcuts
into Budget, Laoka, the map and the chat), a **real** maskable icon, and
`public/sw.js`. Registration happens in both hosts, so every tab serves the
same manifest, `apple-touch-icon` and `viewport-fit=cover` viewport.

* **A maskable icon must not be a copy of the plain one.** Android crops a
  maskable icon to the platform's shape; the brand kit's
  `pwa-maskable-512.png` was a byte-for-byte duplicate of `icon-512.png`, which
  clipped 111px of the mark once the circle was applied. It is regenerated
  with the mark inside the safe circle. `npm run smoke` compares the *served
  hashes*, because a duplicate is invisible to any HTML-level check.
* **Both service workers cache static assets only — never HTML, never an API
  response.** Every page here is server-rendered for ONE signed-in person on a
  possibly shared device, so a cached `/budget` or `/way/index.html` would hand
  one person another person's page the moment the network blinked. There are
  TWO workers — `public/sw.js` at scope `/` and `public/way/sw.js` at scope
  `/way/` — and because a narrower scope wins for a /way/ URL, the stricter one
  is worthless if the other breaks the rule. `/way/sw.js` did: it precached the
  shell and fell back to a cached `/way/index.html` offline (cache
  `way-shell-v2-superapp`, dropped by the rename to `way-assets-v3`). Smoke now
  asserts both files: no document in the precache list, and a navigation never
  answered from cache.
* **Installation is offered, never promised:** the You tab shows *Install Home*
  only when the browser fires `beforeinstallprompt`, with an iOS hint and a
  browser-menu fallback line for everything else.

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
  attempts; 0002: the first per-person ntfy channel + household
  `home_settings`; 0003: `laoka_imports`, the Laoka→Sompitra hand-off ledger;
  0004: the SECOND channel, `users.way_topic`).
  It holds identity AND notification identity — a channel belongs to a person,
  not to an app — and there are **two** of them, because the two halves of the
  app are filtered differently (see "Notifications" below). It also holds the
  only record of a fact that belongs to **two** modules at once, which is why
  the shopping-list hand-off ledger lives here rather than in either module's
  database (see below).
* `sompitra-db` — migrations in `migrations-sompitra/`.
* `way-db` — migrations in `migrations-way/`.
* `laoka` — migrations in `migrations-laoka/`.

The three module migration folders mirror the standalone repos and are treated
as read-only: they are the modules' own history, and an index or a column added
here would silently fork them. What that costs is written down in
**`DB-REDESIGN.md`** (the proposal, not a plan of record) — most concretely,
`way-db` has **no indexes at all**, so every history load scans `gps_pings`,
which is the free tier's read budget and the first thing that will misbehave at
volume.

Durable Objects: `FLEET_DO` (W.A.Y live fleet + chat) and `LOBBY` (Laoka
metadata-only fan-out). Cron `0 21 * * *` flushes the FleetDO into way-db —
**that cron is the "today" boundary for W.A.Y; never move it to UTC midnight.**

## Notifications (two channels per person)

Before the merge each app had its own idea of "where notifications go":
Sompitra pushed to a single household topic, W.A.Y owned a topic per person.
The merged app has **two channels per person**, both owned by `home-db`,
because the two halves are filtered in opposite ways:

| Column | Channel | Delivered to | Decided by |
| --- | --- | --- | --- |
| `users.ntfy_topic` | 💬 the **feed** — expenses, income, Kiné, in the chat's wording | every active person, **including whoever recorded it** | nothing: Sompitra's rule is "any activity goes out" |
| `users.way_topic` | 📍 the **tracking** channel — chat, entry, exit, stationary, moving, approach | each recipient who ticked that activity for that person | W.A.Y's grid (`way-db.notification_subs`), never the person whose action it was, plus their quiet hours |

One topic could not do both jobs. "You are not notified about your own
arrival" is incompatible with "the whole household sees every expense, mine
included", and a household wants to silence location noise at night without
going deaf to the budget. Splitting them is also what makes W.A.Y's grid mean
what it says: a grid that gated bank notifications too would be a surprise.

* **Two publishers, two addresses.** Sompitra pushes through
  `src/lib/notify.ts` (whole `Env`, fans out to every feed channel). W.A.Y
  publishes from inside the FleetDO, whose `getNotifyConfig()` resolves each
  recipient's **tracking** channel from home-db. Both read the same identity
  database — that is what keeps one phone = one pair of topics no matter which
  module publishes.
* **The DO caches them**, so every channel or server write in `/settings`
  calls `reloadWayNotifications(env)`; a rotation that skipped it would look
  like a silent failure for W.A.Y activity only. `GET /way/api/debug/notify`
  reports the exact tracking topic per person and the server in force, and
  `/way/api/users` (W.A.Y's own admin screen, where a phone actually copies
  its topic from) now answers from identity too — reporting its own stale copy
  is precisely how it once handed out a topic that received nothing.
* The ntfy **server** is household-level (`home_settings.ntfy_server`), with
  a fallback read of Sompitra's legacy `app_settings.ntfy_server`, and then of
  the deployment's own `NTFY_URL` — the same chain W.A.Y's DO has always run
  (setting → env → default). The order matters: without the last step a
  deployment that never wrote the setting pushes tracking events and silently
  drops money ones, which reads as a bug in the money path rather than a
  missing value. `npm run smoke` compares the server each half reports, so the
  two can no longer disagree unnoticed.
* **A push reports what the server said.** `pushTo` returns `{ok, detail}`
  instead of discarding the response, so **Send a test** answers with ntfy's
  own status (`ntfy accepted it (200)`, `ntfy refused it (401): invalid access
  token`, `could not reach …`) rather than "Test sent". The one time a person
  presses that button is the time nothing is arriving, and a green tick over a
  refused push is the least useful answer the app could give. The household's
  money fan-out logs the same detail per channel when a push is refused.
* W.A.Y's existing topics are **adopted into `way_topic`** (case-insensitive
  username match) rather than abandoned — the phone in the field is still
  following them — and every tracking write is **mirrored back into `way-db`**
  so a rollback to the standalone Worker (`CUTOVER.md` §6 — one
  `wrangler deploy` per module repo) publishes to the topic the phone is really
  following rather than to the one it replaced.
* A person with no channel on a side is skipped there; the whole push no-ops
  without a server. Notifications are best-effort and never break a user
action.

### The three ways a notification disappears without a trace

Each is silent by design, and each is now named somewhere on screen:

| It vanishes because | Named by |
| --- | --- |
| the recipient has no channel on that side | the household card in `/settings`, which lists both topics per person and warns when W.A.Y's grid has events for someone who has no tracking topic ("she was subscribed and heard nothing") |
| quiet hours are running (22:00–06:00 by default, tracking side only, chat exempt) | the 📍 card in `/settings` states the window and says whether it is on **right now** |
| W.A.Y's grid has no cell for that person × activity | `GET /way/api/debug/notify` reports per-event recipient counts and the last routing decision in words (`niri has no topic`, `cooldown (12s since last)`, `quiet hours for niri (22-6)`) |

All of this is managed in one place: **`/settings`**, organised by who a
setting belongs to (You / the household / a module) rather than by app.

### The chat's data path is shared, so watch it during any cutover

The chat is the one surface every module now depends on, and it has a failure
mode that is invisible in the UI. Live messages travel over `/ws` straight from
the DO, but **history** (`/way/api/chat/history`) is only what the daily flush
has already written into `way-db`, as are map tracks. `messages.device_id`
carries `REFERENCES devices(device_id)`, and D1 resolves FK parents at write
time — so a missing `devices` table makes the flush fail as a whole (even for
rows with a NULL `device_id`) while the live chat keeps working perfectly. The
symptom is "history is empty and old tracks vanished", not an error. See
`CUTOVER.md` and `scripts/repair-way-messages-fk.sql`.

## The Laoka → Sompitra hand-off (no CSV hop)

Laoka's week ends as a priced shopping list; Sompitra's budget is where that
money belongs. The two were joined by a **file**: Laoka exported a CSV
(`/api/weeks/:id/export`), the person downloaded it, opened Sompitra's
itemized-expense modal and re-picked it through "Import CSV". Four steps and
a file, for numbers both apps already held.

Now there is a button in Laoka's export sheet (`public/laoka/app.js`) and two
endpoints in Sompitra's router (`src/routes/budget.tsx`):

| Route | Purpose |
| --- | --- |
| `GET /budget/laoka-import?week=N` | Status for the button: sent or not, which expense, how much, when |
| `POST /budget/import-laoka` `{week:N}` | Create the expense, or refresh the one this week already owns |

The rules that make it trustworthy, each of which a naive implementation
gets wrong:

* **The week id is the expense's identity.** `home-db.laoka_imports` is keyed
  by `laoka_week_id`, so the operation is idempotent by construction: a
  second press is an UPDATE, never a second expense. This is the difference
  from the CSV path, which carried no identity and could double-charge the
  budget if the same file was imported twice.
* **A stale ledger is not a lie.** If the expense was deleted in Sompitra,
  the status endpoint reports `stale: true` rather than `sent: false`-with-no-
  explanation, and the next send creates a fresh expense and re-points the
  ledger. `sent` is answered by *looking the transaction up*, never by
  trusting the ledger alone.
* **Once the expense exists, the household's edits win.** A re-send refreshes
  `amount` and `notes` only — never `date`, `description` or `category_id`,
  which may have been chosen by hand afterwards.
* **The notes mirror the CSV contract exactly**, because the itemized render
  (and `parseItemLines`) already depend on it: one `Name: Ar 1,234` line per
  priced line, sorted A→Z case-insensitively, prices truncated to whole
  units, unpriced lines omitted. `laokaPricedLines()` in budget.tsx copies
  Laoka's `buildCsv()` filtering and ordering so both routes produce the same
  expense. The week is also stamped `exported_at`, the same flag the CSV
  export sets, so Laoka's own "already exported" warning stays truthful.
* **The chat is told once.** Only `action === 'created'` calls
  `notifyTransaction`. A re-send is a correction to numbers already
  announced; repeating the "💸 … Ar 46 600" line would read as a second
  purchase — exactly the confusion idempotency exists to prevent.
* **It is a module-to-module read, not a module-to-module import.** The
  endpoint reads `laoka-db` through the `LAOKA_DB` binding; Laoka's own code
  is never imported into Sompitra's router, so neither module's release can
  break the other by surprise.

`npm run smoke` asserts the identity property directly (a re-send must return
`action: 'updated'` with the **same** transaction id and must not increase the
row count on `/budget/transactions`), plus that the expense renders as an
itemized list. The suite deliberately does not create a week that was never
sent — that would put money in the household's budget behind their back; it
reports the write half as **skipped** until a week has been sent once.

## Forgetting a template

A Laoka week runs through three stages, and only the last one is history:

| Stage | How you know | Can it be thrown away? |
| --- | --- | --- |
| **Draft** | a wishlist (`is_selected = 0`) | yes — `DELETE /api/weeks/:id/candidates` |
| **Template** | `status = 'active'`, `confirmed_at IS NULL` | yes — `DELETE /api/weeks/:id/plan` |
| **Settled** | `confirmed_at` set | no — swap single days, or archive |

The template is the stage a household actually shops from, so it has to be
abandonable: rolling again only *replaces* the plan, and the prices already
typed into the list it produced would stay behind attached to a week nobody
wants. `DELETE /api/weeks/:id/plan` (the **🗑 Discard the template** button on
Laoka's Plan tab) therefore:

* deletes **every** plan the week owns — a leftover draft included, or it would
  reappear as a wishlist the moment the week was looked at again;
* puts the week back to `planning` and clears `exported_at` and `generation`,
  both of which described the plan that no longer exists;
* re-runs `syncShoppingLines()`, which with no selected plan keeps exactly the
  Pantry lines (and the prices typed on them) and drops every plan line — the
  same function that keeps the list honest when a single day is swapped;
* refuses a **confirmed** or **archived** week with 409. That guard is the whole
  safety story: `confirmed_at` is the boundary between a proposal and history,
  so the client never has to guess which side of it it is on.

Nothing is sent to the chat about a discarded template even when the week had
been sent to Sompitra: the budget entry is real money that was spent, so
discarding the plan it came from must not read as a correction to it.

## The W.A.Y map is drawn on a playback clock (viewer only)

The dashboard no longer redraws itself on every ping, and the map deliberately
trails live by 25 s. Nothing that W.A.Y *does* changed — this is the one place
where that has to be said explicitly, because the code that changed is the code
that decides what a track looks like.

**Why it was rebuilt.** Every ping used to (1) `map.panTo(device)` — a 0.4 s
slide that finished long before the next one, so the world moved in steps under
a device that never left the centre of the screen, (2) destroy and re-add every
marker, and (3) `redrawAllTracks()`: clear **all** polylines for **all** devices
and rebuild them from the whole point list. A 5 s ping cadence therefore looked
like move–freeze–move, and any animation was thrown away on the next arrival.

**What replaced it** (`public/way/index.html`, no server or schema change):

* **A playback cursor.** A point is drawn when `Date.now() - 25 s` reaches it,
  interpolated between its two neighbours — so the marker glides at the speed
the server recorded instead of hopping ping to ping. This only works because
the cursor never passes a point that has not ARRIVED (the exit guard holds pings
and delivers them later as `track` messages), and because a trail break
(`TRACK_GAP_SECONDS` = 90 s) is *held* rather than crawled across: there are no
points there, so the marker waits and eases the last stretch.
* **An append-only trail.** `commitTrail()` is the old `drawSegments()` loop
  made resumable: identical breaks (gap / mode change), identical styles, but a
  committed segment is never touched again, and the pair under the cursor is a
  live "tail" that grows with it. `resetTrail()` is the rare full rebuild — a
  fresh snapshot, the track eye switched back on, or a late `track` point that
  slots in *before* the cursor and shifts every commit index.
* **A follow camera that works in cycles.** Four phases, one at a time:
  DRIFT → PUSH → PULL → DRIFT. The device roams a **circle** in the middle of
  the screen (`FOLLOW_ZONE_DIAMETER_FRACTION` of the shorter side) while the map
  sits still; the map holds for `FOLLOW_PUSH_MS` (380 ms) while the device
  shoves a few pixels past the edge; and then the camera **sweeps it to the
  opposite edge** of that circle, with an ease that overshoots its aim by
  `FOLLOW_PULL_SPRING`'s few percent and settles — a spring, not a slide.

  **A circle, not a box.** The eye judges "too far from the middle" as a
  *distance*, not as two independent axis limits, so a diagonal drift deserves
  the same room as a straight one — and a circle leaves the four corners of the
  screen alone, which is exactly where the HUD (top-left) and the badge strip
  (bottom-right) live. On a 423×768 map the circle's lowest point is 55 px clear
  of a two-badge strip where the old box's corner was 11 px from it. The radius
  comes off the **shorter** side so the circle always fits: on a portrait phone
  that is exactly "70% of the screen width", and on a wide desktop map it is
  the height, which is the side that would otherwise push the device off-screen.

  **Sweeping to the opposite edge, not back to the middle.** This is what makes
  a cycle worth having: the device then has the whole diameter to cross before
  the camera reacts again, so the map is still for twice as long and the
  recentres are half as frequent. Note what does NOT change: the camera's total
  travel is the same either way, because it has to end up wherever the device
  went. The only two things there are to choose are how OFTEN it moves (this
  circle) and how FAST (the ratio).

  **A ratio, not a duration.** The pull lasts `FOLLOW_PULL_RATIO` (3) of the
  drift it just watched, so it crosses the same distance in a third of the time
  and the device is swept back at 3× the rate it drifted out (the camera itself
  runs at 4×, since the device keeps moving while it is carried). A fixed
  duration — the 1.6 s, then 4.8 s, of the first two attempts — is wrong at both
  ends of the speed range: the sweep that reads as a calm slide at 80 km/h is a
  violent one at walking pace, where the device has barely covered the same
  distance, and a long fixed sweep at driving speed keeps the camera moving for
  most of a cycle. `FOLLOW_PULL_MIN_MS` (1.5 s) is the floor for the one case
  with no drift to measure — the device was *placed* outside the circle (a pace
  switch, a fresh follow, a reconnect) rather than drifting out of it.

  **It lands just inside the circle** (`FOLLOW_PULL_LANDING` = 0.93 of the
  opposite extreme), and that hair of hysteresis is load-bearing: at exactly the
  opposite edge the device is still outside the circle on the frame the pull
  ends, so the trigger would fire again immediately and forever.

  The pull sweeps from the offset the device had when it began to -0.93 of it
  **while still following where the device is**, so a device that keeps driving,
  turns or stops is drawn correctly throughout and lands on the far edge either
  way; that is what makes the camera move with the device instead of aiming at a
  fixed point. Every frame is a `panBy` of a pixel or two — which is what
  Leaflet's own animated pan does internally — and deliberately not `panTo` (it
  would pick a landing point and stop moving with the device) or `setView` (it
  fires `viewreset` and re-projects every layer).

  This replaced a camera that re-centred **only by the overshoot**, which left
  the device pinned to the edge of the box for as long as it kept moving — so
  the tracker spent a long drive half-hidden behind the HUD and the badge strip,
  with the road ahead off-screen. Measured on a 423×768 map at 120 km/h: a
  296 px circle, the marker entering it at 149 px and leaving the sweep at
  **-142 px** (the far edge, a hair inside), the camera moving **0 px** for the
  whole drift, and one cycle per **26.5 s** of which 19.6 s is a motionless map
  — where the per-ping pan this all replaced moved the map 20 times in 20 s.
* **The lag is also the pace, and the pace is the user's.** The lag above is
  what makes a commute watchable, and it is also 25 s of "wrong" whenever the
  question changes from *how did the trip look* to *where is he right now*. So
  the map has two paces, switched in Settings → Map (and deliberately nowhere
  else — a control floating over the map is one more thing between the eye and
  the device, and the badge below is what the map itself has to say):
  **Smooth** (the default, this lag) and **Live**, where
  `playbackLagSeconds()` returns 0 and the marker is the newest ping the moment
  it arrives. Only two things differ: the clock, and the marker's ease rate
  (`MARKER_EASE_PER_SECOND_LIVE` = 3/s, so a live marker still glides rather
  than snaps). Same playback loop, same append-only trail, no re-fetch, no
  server setting — it is `localStorage`, per device. Flipping it calls
  `redrawAllTracks()`: the cursor just moved 25 s, so what is already drawn is
  either too much (to Smooth) or too little (to Live), and `resetTrail()` is the
  one correct answer for both.
* **The HUD stays live.** `latestPing` (speed, cadence, accuracy, today's card)
  is still the newest ping; only the *drawing* is delayed, and the lag is named
  in the one place that owns it: a blue line under the pace pills in
  **Settings → Map** (`updatePaceNote`), shown on Smooth and removed on Live. It
  used to be a HUD badge; a card about the device was the wrong home for a
  setting, and `~0s behind` would have read as a bug rather than a choice.
* **The HUD's footer reads what the tracker actually sends.** The left slot is
  battery when a tracker reports one; μlogger does not (96 of 12,077 pings ever
  carried a level, all on the old app's first day — and the live push never
  carried the field either), so it shows **GPS accuracy**: `±1.6 m`, present on
  every ping, with a title saying why, and `—` when a device's stored status
  predates the DO sending it (one ping fixes that). `accuracy` is informational
  only — no classification, storage, notify or trail decision reads it. The
  right slot is the ping's age, **clamped at 0**: a phone a second ahead of the
  viewer used to print `-1s ago`, and an age can never be negative.
* **The badge's address column is a cache, not a callback side effect.**
  Nominatim is asked at most once per 20 s per device, and only when it moved
  >150 m or the text is >5 min old (never while parked where it is already
  known, never inside a fence — the fence is the answer). The resolved text is
  stored per device (`addressCache`, persisted to `localStorage['way_addresses']`)
  and re-applied on every render, because `renderBadges()` rebuilds each badge on
  every ping — text written only from the fetch callback was wiped seconds later,
  which is exactly what made the column look broken. The three lines are the
  street (with its house number when OSM has one), the suburb, and the first
  geographic division, each taking the next **distinct** value so a place OSM
  has no street name for cannot print the same word twice. Cached text more than
  400 m from the device is hidden rather than shown: a stale address looks
  authoritative.
* **The Trips summary is a different data path on purpose.** Monthly
driven/walked totals come from `GET /way/api/history` (D1) and are summed
  through yesterday; today's card is computed from the **complete**
  `devicePings` list, never from the playback buffer. `devicePings` stays the
  complete, timestamp-ordered record — the buffer and the commit state are
  additive display state, never a truncation of it.

**Invariants this rewrite is not allowed to break:** the geometry, colours
(`SPEED_COLOR_STOPS`), walking dash, gap rule, stationary dots (colour, radius,
20 m clustering), the glitch filter / state machine / `shouldDrawPoint`
filters, the 21:00 flush and the **Flush now** button.

**The 120 km/h law, in both halves.** `WAY_CONFIG.PRE_FILTER_SPEED_LIMIT` is
what counts as GPS jitter, and it is applied twice because the number can arrive
two ways. A ping whose **position** implies more is dropped whole and silently
before the state machine (`isGlitch`) — the upload still answers success, like
the Python receiver it was ported from. A ping whose **reported** μlogger speed
claims more keeps its position and loses only that field: the phone captures
that speed independently of the coordinates it travels with, so the position
check cannot see it, and a 250 km/h claim would otherwise reach the
classification, the rolling average, the live HUD, the stored row,
`pending_sync` and the approach ETA. It is **discarded** (null — "not reported")
rather than clamped: a clamp would invent a 120 km/h drive out of a jitter ping.
Every consumer already handles a missing field (`ping.vel ?? result.speedAvg`),
and the rule is asserted by smoke section 15 with a real μlogger proof in the
run doc.

**The reported speed has a second pre-filter, and it is the quiet one.** The
limit above only catches an impossible claim; a *believable* one is the harder
case, because it comes from a device that is genuinely parked. Indoors a phone's
GNSS chip reports 5–30 km/h while its coordinates stay inside a few metres — and
those coordinates are often accurate to a couple of metres, which is precisely
why μlogger's own accuracy filter cannot catch it: that filter judges the fix,
never the movement. Trusting that report is what turns a phone on a table into a
{"driving"} device: the ping is persisted as a track dot, its distance lands in
the driven totals, and the approach ETA is computed from it, so a parked phone
can be announced as "~60s from Home". `reportedSpeedIsCredible()` therefore asks
the one question the report cannot answer for itself — did the device actually
MOVE `REPORTED_SPEED_MIN_MOVE_M` (20 m) since the previous ping? — and an
uncorroborated report is **replaced by the speed the positions imply**, not
nulled (the device is real and merely parked; a null would print "No signal" in
the HUD). Under 5 s a gap cannot tell a crawl from a jittering fix, so a short
gap keeps the report. Same shape as the limit: applied at the DO's intake and
again inside `processPing`. In the household's own history this cost 900 rows,
831 of them counted as driving, inside 400 m of home over three days. `npm run smoke` section
15 asserts the served page still carries every one of those values and that the
ping path no longer redraws; the equivalence itself was verified by running the
OLD segmentation against the same committed points and diffing layer by layer
(same order, same styles, same coordinates).

**Debug recipe** (no data written): in the dashboard console, feed synthetic
pings through the real handler — `handleNewPing({deviceId:'MaxX', timestamp:new
Date().toISOString(), latitude, longitude, speed, is_driving:true, ...})` — then
watch `markerPositions`, `trailFor('MaxX').drawnIdx` and `followCam`. Calling
`playbackPosition([...])` directly unit-tests the cursor's edge rules in
isolation. Two Leaflet details worth knowing: `latLngToContainerPoint` reports a
STALE pane position during an animated pan, so measure offsets from `followCam`
(pure metres) instead; and `ignoreMapEvents()` is a deadline, not a flag, because
a `flyTo` fires `zoomstart` twice and a one-shot flag let the second one cancel
the follow it had just started.

## Invariants worth defending

* Module databases and session mechanisms stay native — no shared sessions
  table, no cross-module queries in module code.
* `home-db` never stores module data and modules never store identity.
* Every module call from the identity engine is wrapped in try/catch: a
  broken module must never break login.
* One login per person, admin-managed; no self-signup anywhere.
* Colour palettes of each module are untouched — Laoka stays orange, W.A.Y
  **sky** (`#0284c7`, the colour its own tab carries), Sompitra's Tailwind theme
  as it was. The **chrome** is shared; the module internals are never restyled.
  The money legend above is the exception that proves the rule: it is about a
  fact the whole app reads, not about how a screen looks, so a screen that
  prints money in a colour the legend does not own is a bug rather than a style.
* Module documents detect the shell themselves (`window.self !==
  window.top` → hide own chrome). Never try to style iframe content from the
  parent document — same-origin CSS cannot reach in; only an injected script
  or a fetch-time rewrite can.
* The chrome exists in exactly one file (`src/views/app-chrome.tsx`). Two
  hosts imported their own copies once and drifted — the module tabs ended up
  with emoji icons, no dark-mode toggle and no `.pb-safe`. `npm run smoke`
  now asserts the rendered tab bar is identical on every tab, which is what
  keeps that from silently returning.
* **W.A.Y's viewer may only change WHEN its state is drawn, never WHAT.**
  Backend behaviour — what is tracked, dropped, written, classified or
  flushed — is out of scope for any map/UI work, and so is every style value
  that decides how a track looks. The playback clock and the follow camera's cycle
  are display-only: `devicePings` stays the complete ordered record the Trips
  card sums (or the household's own numbers start disagreeing with the
  database), and the HUD stays live while the map is behind. The **approach
  pulse** is the one addition that crosses that line, and it crosses it in one
  place only: the DO broadcasts the threshold it was ALREADY notifying about
  (`maybeNotifyApproach`), and the browser decides nothing except how the pulse
  looks and when its window closes. Same thresholds, one decision, three
  deliveries — a push for when nobody is looking, a badge ring for when they
  are, and a **chat row** for the record afterwards. The row is the part the
  household reads later, so it is written unconditionally (before
  `notifyEvent` filters per recipient), exactly like `arrived` / `left`;
  `moving again` and `stopped at …` remain push-only because they fire on every
  trip segment. The visual is deliberately two parts: the card says **which** device — a
  3px band drawn **inward** (so nothing is painted outside a card) and its one
  status line handed over to the countdown — and a **radar layer over the map**
  says **how close** — rings that leave the card, cross the map and fade out. That split is forced by the layout: `#badge-strip` is an
  `overflow-y: auto` scroll container, so a ring drawn inside it is clipped to a
  170 px column and the cue becomes invisible in practice (which is exactly how
  the first version shipped).
* **Unread is a watermark, not a count.** `chat_last_seen` (per device, an ISO
  instant) against the DO's newest message, polled from `/way/api/chat/latest`
  on every page. `/chat` never shows the dot — being in the room advances the
  watermark instead — and a device's first poll adopts the backlog as seen. Dead
  simple on purpose: a counter would need every reader and writer of the room to
  agree, and being wrong about unread is worse than being vague.
* **The chat's unread state is a watermark in the browser, the chat's content is
  the DO's.** Nothing is written to mark something as read: `/chat` advances
  `chat_last_seen` instead of showing a dot. That keeps the server out of a
  per-device preference and means a new phone starts clean rather than inheriting
  someone else's "read" flags.

## Testing locally

There is no test framework; `npm run smoke` (`scripts/smoke.mjs`, zero
dependencies) is the end-to-end gate and `npm run check` is the type gate.
Run both against a live dev server with `npm run verify` before deploying.
The smoke suite covers exactly the invariants above: one login → four
cookies, every tab/API 200, module documents gated, bad credentials
rejected, chrome identical everywhere, `home_session`-only self-repair,
and the two module-to-module hand-offs (Sompitra↔chat, Laoka→Sompitra).
Where a check would write to the household's own data it reports **skipped**
rather than passing quietly — a green suite must never mean "wiped the
family's week to prove it could".
