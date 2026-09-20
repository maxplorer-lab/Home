# Cutting over to Home — production runbook

> **Status: executed.** Home is live at `https://home.maxx-lab.workers.dev`;
> this file is kept as the record of *why* each step existed, not as a to-do
> list. §1 and §4 describe what was done at cutover, §3's ordering still
> applies to any future move, and §5 is the part whose value is permanent —
> do keep it working (`npm run smoke` compares the `build` marker §5 tells you
> to expect against the one the Durable Object actually reports).
>
> **Two gaps found after the cutover** (2026-09-19, fixed on production):
> `way-db` had no `devices` table, so the FK on `messages.device_id` made every
> chat insert fail, and `messages` was missing migration 0007's reaction
> columns, which did the same. The chat/activity history was therefore frozen
> at 2026-08-27 while the live chat looked healthy. §1d now covers both.
>
> **Step 3.3 is done** (2026-09-19): all three standalone Workers are deleted.
> They had received zero requests for days, the phones were verified to be
> posting to Home's `/ulogger`, and the old `way` DO's chat backlog was flushed
> into `way-db` first (466 messages, reaching back to 2026-09-07) — deleting a
> Worker destroys its Durable Object storage, so that flush is the one step
> that must not be skipped. Its pings were already in D1 from the nightly cron.

Sompitra, W.A.Y and Laoka were each already live as standalone Workers, with the
same two people (`MaxX`, lowercase `niri` — and the case matters, see §1d) and
real data. This is how to move to the merged
**Home** Worker without losing the data that matters (Sompitra's) and without
silently breaking the parts that keep working by accident.

The governing fact: **Home binds the SAME three production databases by their
real ids.** `wrangler.jsonc` already carries them, so no module data moves:

| Binding | Database | State |
| --- | --- | --- |
| `DB` | `sompitra-db` (`701cd942-…`) | **keep — this is the real data** |
| `WAY_DB` | `way-db` (`e098df3d-…`) | keep (or wipe; see below) |
| `LAOKA_DB` | `laoka` (`24acf3ed-…`) | keep (or wipe) |
| `HOME_DB` | `home-db` | created at cutover; `wrangler.jsonc` carries its real id |

---

## 0. What carries over by itself, and why

**Sompitra's data survives untouched, attribution included.** On login Home
provisions each module by looking the person up with
`WHERE lower(username) = lower(?1)`, and when a row is found it is **left
alone** (`src/identity.ts`). MaxX's existing Sompitra `users.id` (a uuid) is
therefore reused, and every `transactions.added_by_user_id` keeps pointing at
him. Nothing re-creates accounts, so nothing re-attributes spending.

**W.A.Y's phone credentials survive too**, as long as you keep `way-db`:
existing rows keep their `password_hash` untouched on provisioning.

The rest (WAY tracks/chat, Laoka plans) genuinely can be reset — the only
module whose loss is unacceptable is Sompitra, and it is safe by construction.

---

## 1. Do this before deploying (each one is a real, verified failure mode)

### 1a. Create the identity database — done
```bash
npx wrangler d1 create home-db
# then paste the returned database_id over the 00000000-… placeholder for HOME_DB
```
`wrangler deploy --dry-run` passes happily with a placeholder id, so a deploy
with one ships a Worker whose login database does not exist — that was the
single most likely way to break the cutover, and rule 17 in `AGENTS.md` keeps
the real id from going back out. With the database created, this is a one-time
step; a later deploy must NOT re-run it (a second `home-db` would be a second,
empty identity database).

### 1b. Apply the identity schema to that database — done
```bash
npx wrangler d1 execute HOME_DB --remote --file=migrations-home/0001_identity.sql
npx wrangler d1 execute HOME_DB --remote --file=migrations-home/0002_notifications.sql
npx wrangler d1 execute HOME_DB --remote --file=migrations-home/0003_laoka_imports.sql
npx wrangler d1 execute HOME_DB --remote --file=migrations-home/0004_two_channels.sql
npx wrangler d1 execute HOME_DB --remote --file=migrations-home/0005_diagnostics.sql
```
(0001–0004 are applied in production; **0005 is the one that must be applied
before the release that ships `/admin/diagnostics`** — without it the page
renders an honest "the ledger is unreadable" instead of the notification
ledger, and nothing is recorded. A fresh environment needs all five, in this
order — 0004 rewrites the channel columns 0002 created.)
The three module databases are already migrated in production (their schemas
exist) — only the new one needs this. Do **not** blindly re-run the module
migrations remotely; several use bare `CREATE TABLE` / `ALTER TABLE` and will
abort on an already-migrated database.

### 1c. Give MaxX back Sompitra's admin pages — done, and no longer load-bearing
Sompitra's `is_admin` is **not** re-derived on provisioning — an existing row
keeps its flag, and the Home role is only applied when a row is *created*. So
the Home admin does not automatically become the Sompitra admin:
```bash
npx wrangler d1 execute DB --remote \
  --command "UPDATE users SET is_admin = 1 WHERE lower(username) = 'maxx'"
```
**Run it for a clean state, but the app no longer depends on it.** The one
surface that used to gate on the module flag was `/settings`' household card —
and with it the links to `/admin` and `/admin/diagnostics`, so a Home admin
could be locked out of the console he administers. That card and its three POST
handlers now follow the **central** role (`isSettingsAdmin()` in
`src/routes/settings.tsx`), keeping `is_admin` only as a fallback for a person
whose module row predates the merge. `AGENTS.md` rule 13 states the rule and
`npm run smoke` section 10 pins it.

### 1d. Verify `way-db` still has the `devices` table
```bash
npx wrangler d1 execute WAY_DB --remote \
  --command "SELECT device_id FROM devices"
```
`messages.device_id` carries `REFERENCES devices(device_id)`, and SQLite/D1
resolve FK parents at write time — so if `devices` is missing, **every** insert
into `messages` fails and the DO's whole flush aborts. The symptom looks nothing
like a schema problem: `POST /way/api/flush` returns
`D1_ERROR: no such table: main.devices`, `/way/api/chat/history` is
permanently empty, map history is empty, and unsynced rows pile up inside the
DO. The row list also has to contain every `device_id` used in auto events —
which is the person's `way-db.users.username` **verbatim, case included**
(`deviceId = user.username`). Production's people are `MaxX` and lowercase
`niri`, so a `devices` row named `Niri` fixes MaxX's arrivals and leaves niri's
still failing.

If it is missing, restore it with `scripts/repair-way-messages-fk.sql`
(idempotent; safe on a populated database, and it derives the rows from
`gps_pings`/`users` rather than hardcoding names).

**Check the columns too, not just the parent.** D1 rejects an insert that names
a column its table lacks — at *prepare* time, so the flush aborts before writing
anything — and a module database can be missing an `ALTER TABLE` migration
entirely. Production was: `messages` had no `reactions`, `reaction_users` or
`reaction_updated_at` because `0007_chat_reactions.sql` had never been applied,
which kept the chat frozen even once `devices` was back. Compare both sides:
```bash
npx wrangler d1 execute WAY_DB --remote --command "PRAGMA table_info(messages)"
```
and apply whatever is missing (`0007` is single-use: a "duplicate column" error
means it already applied).

### 1e. Local dry run first
```bash
npm run check && npm run verify && npx wrangler deploy --dry-run
```
`npm run smoke` needs a running server; it covers the whole surface including
the chat round trip (Sompitra expense → chat system row).

---

## 2. Secrets

```bash
npx wrangler secret put SETUP_TOKEN      # do this FIRST; see below
npx wrangler secret put AUTH_PEPPER      # ≥16 chars; signs Home passwords
npx wrangler secret put SESSION_SECRET   # signs module sessions/device tokens
npx wrangler secret put NTFY_TOKEN       # only if the ntfy instance needs auth
```

`SETUP_TOKEN` is not required by the Worker, but on a public hostname it is
the difference between "the first person to find `/bootstrap` becomes admin"
and "only someone holding the token does". Set it *before* `AUTH_PEPPER`: the
claim route opens the moment a pepper exists, and setting the token afterwards
leaves that window open in the meantime.

- `AUTH_PEPPER` is new (Home-only). It is the reason both people set a new
  password at bootstrap. **Changing it later invalidates every Home password.**
- `SESSION_SECRET` signs W.A.Y's device tokens. Reusing the production W.A.Y
  value keeps any still-valid device session working; a new value simply makes
  each phone re-authenticate once.

---

## 3. Deploy, in an order that avoids two writers

1. **Deploy Home** (`npm run deploy`) — it is additive; the old Workers keep
   serving their own domains.
2. **Verify on the new domain** before touching anything else: log in, open
   each tab, send a chat message, add and delete a test expense.
3. **Disable or delete the three old Workers** (Sompitra, W.A.Y, Laoka).
   This is not cosmetic:
   * the old W.A.Y **cron** flushes its own FleetDO into the *same* `way-db`,
     while Home's cron flushes Home's FleetDO into it too — two writers racing
     over one dataset,
   * the old W.A.Y DO still holds its own `device_state`, so it keeps emitting
     arrival/departure events from a second, stale view of the same phones,
   * the old Sompitra Worker would keep serving its domain against the same
     `sompitra-db`, so the household can end up looking at two frontends with
     two different states.
4. **Re-point the μlogger phones** at the Home domain.

### About the phones (the step most likely to be missed)
μlogger does not use per-request Basic Auth. It calls `action=auth` on
`/ulogger` with a **username and password that are the same as the dashboard
login**, checked against `way-db.users` with an exact-case username match
(`src/way/routes/ingest.ts`). Consequences:

- Keeping `way-db` means both phones keep working with their current
  credentials — the recommended path even though the data is disposable.
- If you *do* wipe `way-db`, each phone must then authenticate with the
  person's **Home username and password**, because a fresh W.A.Y row is created
  from the password typed at Home login.
- Changing the domain invalidates the phone's stored session cookie, so expect
  one re-login per phone.

### About the Durable Object
The FleetDO is a **new instance** under the new Worker name, so its SQLite
starts empty: chat scrollback and per-device `device_state` are gone. Practical
effect: a phone that is *already inside* a geofence at deploy time can fire one
extra "arrived" event on its first ping. Harmless — and the chat now records it.

---

## 4. Bootstrap the two people

1. Open `/bootstrap` on the new domain — the **first account becomes the
   admin**. Create **MaxX** there, using the *same username* the module
   databases already know (`MaxX`; matching is case-insensitive).
2. As MaxX, open `/admin` and create **niri** (the username the module
   databases already know, case included).
3. Each person's notification channels: **You → Notifications** shows two — 💬
the money/chat feed and 📍 W.A.Y tracking — and each is *generated*, not
inherited. To keep the topics the phones already follow, use **Adopt W.A.Y's
tracking topics** there instead: W.A.Y's DO only ever pushes tracking events to
a topic the person ticked in its own grid, and a person with no tracking topic
hears **nothing**, chat notifications included. Money events go to the feed
topic, unfiltered, to everyone who has one. If you wipe `way-db` before this
there is nothing to adopt, and each phone's ntfy app needs its topic re-entered.
4. `/bootstrap` disappears on its own once an account exists.

---

## 5. Post-deploy verification

```bash
B=https://<new-domain>

# Login works and mints all four module sessions
curl -s -c /tmp/j -o /dev/null -w "%{http_code}\n" -d "username=MaxX&password=…" $B/login

# Identity database is really bound (not the placeholder)
curl -s -b /tmp/j -o /dev/null -w "%{http_code}\n" $B/admin        # 200, admin-only

# The DO is running the merged code, not a stale instance
curl -s -b /tmp/j $B/way/api/debug/notify | grep -o '"build":"[^"]*"'
#   expect build notify-v13-sum-partition   (kept honest by `npm run smoke`,
#   which reads THIS line and compares it with the DO's source AND with what
#   the running DO reports — otherwise "the DO is stale" and "this doc is
#   stale" look identical from the outside)

# The diagnostics ledger answers, and the intake gates are readable
curl -s -b /tmp/j $B/admin/diagnostics.json | head -c 400
#   expect "modules":[…all four ok…] and an "ingest" block with a "build" and a
#   "gates" list. An empty "gates" list means a fresh deployment (or that a build
#   bump just cleared them) — send one upload to populate it; the counters are
#   durable, not per-instance, and are cleared only when the DO's code changes.
#   `indexWarning` naming gps_pings is real and expected today (DB-REDESIGN §1a).

# The chat flush completes (this is the `devices` FK check, live)
curl -s -b /tmp/j -X POST $B/way/api/flush
#   expect {"pingsFlushed":N,"messagesFlushed":M} — NOT {"error":true,…}

# Sompitra's real data is still attributed to real people
curl -s -b /tmp/j $B/budget | grep -c "Ar"
```

Then, in the app: each tab loads; one chat message sends and arrives on the
other phone; a budget expense shows up in the chat as a 💸 system row; and the
map shows both devices with live pings.

The `build` marker matters because a Durable Object is **not** replaced by a
plain deploy the way a Worker is — an instance can keep running older code until
it is evicted, so "did my DO change take effect?" is a real question here.

---

## 6. Rollback

The old Workers are **deleted** (step 3.3, 2026-09-19), but rollback is still
cheap: all three module databases are untouched, and each old Worker is one
`wrangler deploy` from its own repo — D1 is bound by id, never owned by a
Worker, so a redeploy finds every row exactly where Home left it. Then point the
phones back (`ulogger` lives on whichever host you tell μlogger). Nothing needs
migrating either way; the only thing a rollback would strand is `home-db`.

What you cannot get back is a deleted Durable Object's storage — which is why
step 3.3 comes **after** step 3.2, and why the old `way` DO was flushed into
`way-db` (466 chat messages, `POST /way/api/flush`) before it was deleted.
