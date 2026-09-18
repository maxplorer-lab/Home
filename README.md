# Home 🏠

One app for the whole household — a family super app in the WeChat style.
**Home** runs three modules inside a single Cloudflare Worker at a single
domain, behind **one login per person**: one username, one password, created
by an admin.

| Module | What it does | Where | Database |
| --- | --- | --- | --- |
| 💰 **Sompitra** | Budget, Kiné, Debts & Credits, Sales & Stock | `/` | `sompitra-db` |
| 📍 **W.A.Y** | Live GPS tracking, geofences, μlogger ingest | `/way/` | `way-db` |
| 🍲 **Laoka** | Weekly dinner planner with a shared shopping list | `/laoka/` | `laoka` |
| 💬 **Chat** | THE family chat **and the app's activity feed** (W.A.Y's FleetDO) | `/chat` | `way-db` |
| 👥 **Home** | Central login + admin console (`/admin`) | `/login` | `home-db` |

Each module keeps its own database and its own palette. Inside Home they run
as **chromeless tabs under one shared chrome** — one header with the Home
brand mark, one bottom tab bar (Home · Sompitra · Chat · Laoka · WAY · You),
WeChat-style. **Chat is WAY's own chat engine**, moved out of the dashboard
into its own page (`/chat/`) — it shares the same realtime socket and the
same FleetDO as the map, so history, replies and reactions are one stream.
WAY itself has no chat any more. Visited standalone (outside the shell), the
modules keep their original UI.

The navigation is **one list with two shapes**: the phone tab bar below 768px,
and the same six tabs laid out horizontally in the header from 768px up (a
phone bar pinned to the bottom of a desktop window is the biggest "this is a
phone page" tell). The icons are the modules' own marks, and Sompitra's is a
receipt — the one shape that still says *expenses* at 20px with no colour
behind it. Every tab keeps **its own colour whether or not it is the
one you are on** — green Home, teal Sompitra, violet Chat, orange Laoka, sky
WAY, slate You — and being *on* a tab is shown by a marker bar, a tinted pill
and a bold label, never by draining the colour out of the other five. Both
shapes come from one list, so a tab cannot exist in one and not the other. On
Android (Chrome/Brave) it installs as a real app: a proper manifest, a
spec-correct maskable icon and a service worker that caches static assets
only — never a page or an API response, because this is a household app on
possibly shared devices.

That one chat is also **where the app reports activity**, so the household
does not have to watch each module to know what happened. WAY's arrivals and
departures were always system rows in it; now Sompitra's money events appear
there too, each in its own colour — 💸 **red** for an expense, 💰 **green**
for income, 🩺 violet for a Kiné event, alongside 📍 green arrivals and 🚪
grey departures. Money in and money out are deliberately different event
types, so a salary landing never reads like a spending row:

```
       10:57 AM
  💸 MaxX - Expense - Gas · Ar 45 000 - Fuel        (red)
       10:58 AM
  💰 MaxX - Income - Salary · Ar 1 500 000          (green)
       10:59 AM
  🩺 New client - Rakoto - Added                    (violet)
```

These are system messages, never attributed to a person, and they arrive with
or without ntfy configured — the chat is the record, ntfy is for reaching
someone who is not looking. One scrollback tells the whole story of the day.

## The week's shopping list becomes one expense

Laoka ends where Sompitra begins: a planned week is priced during the shop,
and the total belongs in the budget. That last step is a **button**, not a
file — in Laoka's export sheet, **Send to Sompitra** posts the priced lines
straight into Sompitra as **one itemized expense** (dated today, filed under
the Groceries category when one exists). No download, no "Import CSV", no
picking a file in a modal.

| | |
| --- | --- |
| `GET /budget/laoka-import?week=N` | Was this week already sent, and to which expense |
| `POST /budget/import-laoka` `{week:N}` | Create it, or refresh the expense this week already owns |

It is **idempotent by construction**: `home-db` keeps one ledger row per
Laoka week (`laoka_imports`, week id is the key), so pressing send twice
cannot charge the budget twice — the second press updates the same expense,
and even a re-import after the expense was deleted in Sompitra is handled
(a fresh one is created and the ledger re-pointed). Once the expense exists,
the household's own edits win: a re-send refreshes the **amount and items**
but never overwrites the description, date or category someone chose by hand.

The itemized list is the same shape the CSV imported into, so Sompitra
renders it as items with a total rather than a paragraph of text. The CSV
download is still there for anyone who wants the file.

## A planned week can be forgotten

Until it is confirmed, a week is a **proposal** — so an unwanted one has to be
walkable-away-from rather than merely replaceable. In Laoka's **Plan** tab, the
"This is the template" card ends with **🗑 Discard the template**: it forgets the
saved plan, every price typed into the list it produced, and the pending draft,
leaving the week open and empty so a fresh plan can be drawn for it. **Pantry
items stay on the list** (with their prices) because they are on every list by
design, and anything already sent to Sompitra **stays in the budget** — money
recorded is not un-recorded by re-planning. A **confirmed** week refuses: it is
settled, and the way out of a settled week is single-day swaps or archiving.

## Settings & notifications

**`/settings`** is the one settings surface, organised by who a setting
belongs to: **you** (name, password), **notifications**, then a section per
module. Module panels are still being folded in; the W.A.Y and Laoka sections
link into their own UIs until then.

Notifications are **two ntfy topics per person**, both owned by `home-db` —
not a topic per app, and not one topic doing two jobs:

| Topic | Carries | Who decides what arrives |
| --- | --- | --- |
| 💬 **Money & chat feed** | Sompitra expenses, income and Kiné — in the same wording the chat shows | Nobody. Every active person gets every event, **including the one they recorded themselves** |
| 📍 **W.A.Y tracking** | Arrivals, departures, movement, chat messages | W.A.Y's own notification grid: who you follow, and which activities. **Nobody is notified about their own events**, and quiet hours apply only here |

So on your phone, one subscription is the household's money and the other is
where people are — you can mute tracking at night without also going deaf to
the budget, and vice versa. An admin sets the household ntfy server once, and
can generate, rotate or turn off either topic for anyone; each person can see,
copy, test and rotate their own in **You → Notifications**.

W.A.Y's existing topics were **adopted** into the tracking channel (never
overwriting a topic someone already follows), so a phone in the field keeps
working — **Adopt W.A.Y's tracking topics** re-runs that for anyone added
later. The topics are also mirrored back into `way-db`, so the standalone
W.A.Y Worker, if it ever serves again, publishes to the topic the phone is
actually following.

## The W.A.Y map

The map is drawn on a **playback clock** rather than ping by ping: the marker
trails live by ~25 s and glides between positions instead of hopping to each
one, and the camera lets the device roam the **middle half of the screen**
before it re-centres (smoothly, along whichever axis it left) — so the map sits
still most of the time instead of chasing every step. What W.A.Y records is
unaffected — the same points, the same classifications, the same colours, dash
and stationary dots, the same **Flush now**. The HUD is live while the map is
behind, and says so (`map ~25s behind`), and the Trips summary keeps reading the
database, so "driven this month" is unchanged.

The trade the lag buys: motion you can actually watch. The cost: a just-arrived
position reaches the map half a minute later. If that ever needs to be
different, it is one number (`PLAYBACK_LAG_SECONDS`) — not a design change.

## One login, how it works

* An admin creates each person at **`/admin`** (username + password + role).
  The account is provisioned into Sompitra, W.A.Y and Laoka immediately.
* **`/login`** checks the password once (against the central `home-db`) and
  mints every module's native session cookie. No module ever shows a login
  screen.
* If a module cookie goes stale, the next 401 transparently re-mints it —
  you never notice.
* `/logout` signs you out of everything. `/change-password` changes it
  everywhere at once.
* The very first deployment is claimed at **`/bootstrap`**: the first account
  created becomes the admin. (Optional `SETUP_TOKEN` secret protects that
  window.)

Databases are the original ones — no data migration, module code reads its
own tables as before. `home-db` is new and holds only people + sessions.

## Local development

```bash
npm install
# one-time: apply migrations to the four local D1 databases (see AGENTS.md)
npm run dev            # wrangler dev on :8787 (pass another port if busy)
```

Test before you deploy (the server must be running):

```bash
npm run check                                  # tsc --noEmit
npm run smoke                                  # end-to-end checks, exit 0 = green
BASE_URL=http://127.0.0.1:8793 npm run smoke   # non-default port
npm run verify                                 # both, in order
npm run deploy:dry-run                         # builds + resolves bindings
```

`npm run smoke` logs in once through `/login` and then proves: all four
session cookies are minted, every tab and module API answers 200, the
module documents are session-gated, bad credentials are rejected without
setting a cookie, the tab bar is identical (real icons, no emoji) on every
tab, each tab keeps its own colour whether or not it is active, both shapes
carry the same six tabs, a jar holding only `home_session` self-repairs on all
three modules, and the install assets are genuinely installable (manifest
fields, icon sizes that match the files, a maskable icon that is not a copy of
the plain one, a service worker that handles fetches). It exits non-zero on any
regression.

Secrets live in `.dev.vars` (never committed): `AUTH_PEPPER` (required,
≥16 chars) and `SESSION_SECRET` (signs W.A.Y tokens). First run: open
`/bootstrap`, claim the admin, then add people at `/admin`.

## Deploy

```bash
# REQUIRED: wrangler.jsonc still ships the placeholder HOME_DB database_id,
# and `npm run deploy` will NOT warn you about it.
wrangler d1 create home-db     # paste the id into wrangler.jsonc (HOME_DB)
wrangler d1 execute home-db    --remote --file=migrations-home/0001_identity.sql
wrangler d1 execute home-db    --remote --file=migrations-home/0002_notifications.sql
wrangler d1 execute home-db    --remote --file=migrations-home/0003_laoka_imports.sql
wrangler d1 execute home-db    --remote --file=migrations-home/0004_two_channels.sql
wrangler secret put AUTH_PEPPER      # NEW — required, ≥16 random chars
wrangler secret put SESSION_SECRET   # reuse the old W.A.Y value
npm run deploy
```

Then open `<your-worker>/bootstrap` once to create the admin, and add the
household at `/admin`.

### Cutover from the three standalone apps

**Full runbook: [`CUTOVER.md`](./CUTOVER.md).** The shape of it:

* Module data needs **no migration** — the Worker binds the same databases
  (`sompitra-db`, `way-db`, `laoka`) the standalone apps used, and Sompitra's
  existing accounts are matched **by username and left alone**, so every
  transaction keeps its attribution.
* Existing **W.A.Y** users whose username matches the new Home username are
  linked automatically (their password/μlogger credential is untouched);
  unknown names get fresh rows on first Home login.
* Two traps worth reading the runbook for:
  * Sompitra's `users.is_admin` is **never** re-derived on provisioning, so the
    Home admin does not become the Sompitra admin — MaxX needs the flag set by
    hand or he loses the finance admin pages.
  * `way-db` must still contain the `devices` table. It is the FK parent of
    `messages.device_id`, and without it the DO's flush fails **as a whole**
    while the live chat keeps working — so chat history and map tracks go
    quietly empty.
* **Disable the three old Workers once Home is verified.** The old W.A.Y cron
  and its FleetDO would otherwise flush the same `way-db` as Home's, from a
  second stale view of the same phones. Re-pointing the μlogger phones is a
  step in the runbook, not an afterthought.
* Sompitra's old PIN logins stop working (by design — the password replaces
  the PIN); sessions minted after the cutover are normal.

## Layout

See `project.md` for the full architecture and `AGENTS.md` for the
engineering gotchas (mount order, cookie-join bug class, hash formats, cron).
