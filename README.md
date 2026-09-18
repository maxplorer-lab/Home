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

## Settings & notifications

**`/settings`** is the one settings surface, organised by who a setting
belongs to: **you** (name, password), **notifications**, then a section per
module. Module panels are still being folded in; the W.A.Y and Laoka sections
link into their own UIs until then.

Notifications are **one ntfy channel per person**, owned by `home-db` — not
a topic per app. Every module (Sompitra's transactions and Kiné events,
W.A.Y's tracking) pushes to the channel of every household member, so one
topic on your phone covers the whole app. An admin sets the household ntfy
server and can manage or regenerate anyone's channel; each person can see,
copy, rotate or turn off their own. W.A.Y's existing topics were **adopted**
(not replaced), so a phone already following one keeps working — the
**Adopt channels from W.A.Y** button re-runs that for anyone added later.

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
npm run smoke                                  # 36 end-to-end checks
BASE_URL=http://127.0.0.1:8793 npm run smoke   # non-default port
npm run verify                                 # both, in order
npm run deploy:dry-run                         # builds + resolves bindings
```

`npm run smoke` logs in once through `/login` and then proves: all four
session cookies are minted, every tab and module API answers 200, the
module documents are session-gated, bad credentials are rejected without
setting a cookie, the tab bar is identical (real icons, no emoji) on every
tab, and a jar holding only `home_session` self-repairs on all three
modules. It exits non-zero on any regression.

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
