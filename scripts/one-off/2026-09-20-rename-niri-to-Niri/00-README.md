# One-off: one spelling for one person — `niri` → `Niri`

Run 2026-09-20 against **all four production databases** (and local dev), because a
family member's identity existed in two spellings and the lowercase one was
load-bearing:

| | `Niri` (capital) | `niri` (lowercase) |
| --- | --- | --- |
| `way-db.devices` | a **cutover seed row** (`scripts/repair-way-messages-fk.sql`), tid `M2`, 🛵, `#e67e22`, credential `CHANGE_ME_niri_device_user` | the **live device** (tid NULL, no emoji/colour) |
| `way-db.gps_pings` | 0 pings, ever | **10,960 pings** |
| `way-db.users` | no such account | her account — **what μlogger authenticates with** |
| `way-db.messages` | 5 rows referencing the seed | 188 sent, 108 referencing her device |
| `home-db` / `sompitra-db` / `laoka` | — | her login in all three |

So this is a RENAME, not a delete: "remove `niri`" taken literally would have taken
her sign-in, her phone's ability to upload, the ping history and her Sompitra
account. See `CUTOVER.md` → "Data fixes".

## Files

| File | Binding | What it does |
| --- | --- | --- |
| `way.sql` | `WAY_DB` | Moves every message onto one device row, deletes the duplicate, renames the survivor, renames the ping history and the chat's name columns, renames the account |
| `home.sql` | `HOME_DB` | The login (display name was already `Niri`) |
| `sompitra.sql` | `DB` | Her login. **Not** `users.id = 'usr_niri'` — see below |
| `laoka.sql` | `LAOKA_DB` | Her login |

## How to run

```bash
cd D:\Freebuff\Home
# LOCAL first — proof the statements are legal on a real database:
npx wrangler d1 execute WAY_DB --local --file=scripts/one-off/2026-09-20-rename-niri-to-Niri/way.sql
# then the real ones, one binding per file:
npx wrangler d1 execute WAY_DB     --remote --file=scripts/one-off/2026-09-20-rename-niri-to-Niri/way.sql
npx wrangler d1 execute HOME_DB    --remote --file=scripts/one-off/2026-09-20-rename-niri-to-Niri/home.sql
npx wrangler d1 execute DB         --remote --file=scripts/one-off/2026-09-20-rename-niri-to-Niri/sompitra.sql
npx wrangler d1 execute LAOKA_DB   --remote --file=scripts/one-off/2026-09-20-rename-niri-to-Niri/laoka.sql
```

Verify: `/tmp/niri-full.mjs`-style scan, or the one-liner in `CUTOVER.md` —
every `= 'niri'` count must be 0.

## Why the order inside `way.sql` is what it is

`messages.device_id` carries `REFERENCES devices(device_id)` and D1 **enforces** it
(that FK once broke the whole chat flush — `repair-way-messages-fk.sql`). So the
children move onto the surviving row FIRST, the duplicate is deleted while it is
unreferenced, and only then is the account renamed. Every statement is guarded by
data (`WHERE ... = 'niri'`, and the delete by `EXISTS`), so **re-running the file is
a no-op** rather than a rollback — which matters, because the Durable Object still
holds today's pings under the old spelling and will write them at the 21:00 flush.
Re-run `way.sql` after that flush (or after her phone re-authenticates).

## Manually, afterwards

1. Her phone, μlogger: **change the username field to `Niri`** (password unchanged)
   and save. The ingest authenticates with a CASE-SENSITIVE lookup
   (`SELECT * FROM users WHERE username = ?`, `src/way/routes/ingest.ts`), and the
   app's existing device session (30-day TTL) keeps working under the old spelling
   until it re-authenticates — which is why pings may still arrive as `niri` for a
   while even with no action.
2. Confirm one ping lands as `Niri`, then re-run `way.sql` if any `niri` rows
   appeared in the meantime.

## Deliberately NOT renamed

* **`sompitra-db.users.id = 'usr_niri'`** and everything referencing it (`sessions`,
  `income_accounts`, `transactions.added_by_user_id`). It is an internal primary key
  derived from the OLD login, invisible anywhere in the app — `ensureSompitraAccount`
  finds the account by `lower(username)`, so the link survives the rename. Rewriting
  a primary key under the finance data buys nothing a user can see.
* `sompitra.category_groups.name = 'NIRI'` — a budget group the household named. That
  is their label, not an identity key.
* `laoka.gourmet.image` — a base64 JPEG whose bytes happen to contain `niri`.
* The TEXT of 121 chat messages that mention her by name, in whatever casing they
  were typed.
