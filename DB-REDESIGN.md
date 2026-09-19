# If we rewrote the databases for a genuinely single app

You asked what I'd change if the schema were mine to redraw, on the constraint
that we stay **entirely inside the Cloudflare free tier**, with all data
disposable **except Sompitra**.

This is a proposal, not a plan of record. Most of it is still unbuilt — but
**not all of it any more**, and the difference matters when reading §4:

* **§4's button exists**, in a different shape. Laoka's export sheet has
  **Send to Sompitra**, which posts the priced week straight into a Sompitra
  expense — no CSV, no file lifecycle. The idempotency §4 asks for is real;
  it lives in `home-db.laoka_imports` rather than in
  `week_shopping_lines.transaction_id`, because Sompitra's own schema stays
  byte-identical to upstream (see §3's caveat, which is why the ledger moved to
  Home's database).
* **§4's `transaction_items` table does NOT exist.** An itemized expense is
  still one `transactions.notes` string, so a single line still cannot be
  corrected or summed on its own. The hand-off is one press; the *structure*
  it writes is still a blob.
* **§2's `events` ledger is not built** — the three notification paths still
  meet at the chat/DO seam rather than in one table.

---

## 0. The free tier as it actually stands (Sept 2026)

These are the numbers the design has to survive. They changed recently in a way
that matters.

| Limit | Workers Free | Why it matters here |
| --- | --- | --- |
| Requests | **100,000 / day**, hard stop | Whole app, all four modules, plus DO calls |
| CPU per invocation | **10 ms** | Already shapes the password hashing choice |
| D1 databases | **10 / account** (we use 4) | Room for a 5th; no pressure |
| D1 storage | **500 MB / database**, 5 GB / account | **This is the real wall** (see §1) |
| D1 rows read | 5 M / day | **Burns fast — see §1** |
| D1 rows written | **100,000 / day** | One row per GPS ping, twice |
| D1 queries per invocation | **50** | Rules out naive per-module fan-out |
| Durable Object requests | 100,000 / day | Chat + live map |
| DO storage | 5 GB, SQLite backend only | Chat scrollback + ping buffer |

**Since 1 September 2026 D1 enforces the free daily limits — queries *fail*
once exceeded, rather than billing overage.** A household app that has been
quietly over-writing for months will now simply stop working until UTC
midnight. That changes retention from "nice to have" to "required".

---

## 1. What genuinely breaks first — and it is not storage

Three problems live in the same place. In order of how soon they bite:

### 1a. There is no index, so every history load scans the whole table

`gps_pings` has **no indexes at all** (the only indexes in `way-db` are the
implicit ones from UNIQUE constraints on other tables). The history query is

```sql
SELECT * FROM gps_pings
 WHERE device_id = ? AND timestamp >= ? AND timestamp <= ?
 ORDER BY timestamp ASC
```

and SQLite's own plan for it is:

```
SCAN gps_pings
USE TEMP B-TREE FOR ORDER BY
```

A full scan means **rows read = the entire table**, regardless of the window
requested — so the cost of loading *one day* of history grows with *all* the
history ever recorded. D1's free allowance is 5 M rows read/day. Once the table
holds ~500 k pings, **ten history page loads exhaust the day's read budget**,
and after that D1 returns errors for everything (per Cloudflare: "you will not
be able to run queries against D1").

The ironic part: an index on `(device_id, timestamp)` fixes both halves at once
— the 5 M/day read budget stops being the binding constraint, *and* history
pages stop getting slower every week. Note the pricing nuance too: writing to an
indexed column costs an extra row written per insert, so this trades write
demand for a much larger read saving. `messages` is unindexed for the same
reason and has the same problem.

The contrast inside our own app is the honest framing of this. **Sompitra is
carefully indexed** — `transactions(date)`, `transactions(type)`,
`transactions(added_by_user_id)`, `attendance_ticks(contract_id/tick_date)`,
payment FKs — because it was built as the serious module. W.A.Y was the
side-project that grew a large volume of append-only telemetry, and it carries
no indexes at all. So the merged app inherited the weakest schema in its
highest-volume module, and the free tier is precisely where that shows up
first.

### 1b. Pings are rows, kept forever

Every ping is written **twice** — once into the FleetDO's `pending_sync`, then
copied into `way-db.gps_pings` by the nightly flush. A ping row is ~16 columns;
call it ~200 bytes. Per device, tracking continuously:

| Cadence | Rows/day | Storage/day | 500 MB reached in |
| --- | --- | --- | --- |
| 5 s | 17,280 | ~3.5 MB | **~2.5 months** (two devices) |
| 15 s | 5,760 | ~1.2 MB | ~7 months |
| 30 s | 2,880 | ~0.6 MB | ~14 months |
| 60 s | 1,440 | ~0.3 MB | ~2.5 years |

An 8-hour driving day is roughly a third of that. The direction is not in
doubt, and Cloudflare is explicit about the ceiling: once the 500 MB storage
limit is reached **you cannot insert at all** until you delete data — new pings,
chat messages, everything stops. Nothing prunes this automatically today:
`deletePingsOlderThan()` exists but is reachable only from the manual
`/api/history/delete` admin call, so retention depends on someone remembering
to click a button.

### 1c. Writes are the least scary, but not free

100,000 rows written/day (D1) and the same again (DO). Continuous 5 s tracking
by two devices is ~34,560 pings/day = ~34 k writes on each side, ~69 k combined.
Comfortable — unless the ping cadence is aggressive *and* the phones track
around the clock, in which case an index on `(device_id, timestamp)` would push
the D1 side toward the ceiling. Worth measuring before optimising blindly.

### What I'd do, in this order

1. **Add the index**: `CREATE INDEX idx_pings_device_ts ON gps_pings(device_id,
   timestamp)` (same for `messages`). One line, and it de-fangs the read budget
   — the constraint most likely to cause a *same-day* outage.
2. **Stop storing what carries no information.** The DO already computes
   `is_stationary`, `is_keep_alive` and `distance_km`. A phone parked overnight
   produces thousands of identical points; those should collapse at ingest to
   one point per N minutes plus any state transition.
3. **Roll up, then delete.** Keep raw pings for a short window (90 days is more
   than anyone scrubs back through) and roll older data into `track_days`
   `(device_id, day, distance_km, first_at, last_at, moving_minutes,
   ping_count)`. **Laoka already uses exactly this pattern** —
   `history_weeks`/`history_lines` are immutable snapshots of a settled week,
   and past weeks export from the snapshot. I'd copy that idea, not invent one.
4. **Make it the cron's job.** The daily `0 21 * * *` handler already flushes;
   it should roll up and prune too. Retention that needs a human is not
   retention.

Steps 1–2 are cheap and independent; 3–4 are what keeps the app on the free
plan for years rather than months. All of it is invisible to the user, which is
exactly why it should happen before it becomes an outage.

---

## 2. One events ledger, instead of three notification code paths

Today each module invents its own idea of "something happened": Sompitra builds
a `NotifLine` and pushes to ntfy, W.A.Y has a *separate* ntfy publisher inside
the FleetDO, and the chat's system rows were the accidental third. They have
already drifted once — WAY kept pushing to a topic nobody followed after the
channel moved, which is the bug that motivated the shared-channel work. That
class of bug is structural, not careless.

**Proposal: one `events` table is the record of household activity.**

```sql
events(
  id, at, actor_person_id, module, kind,          -- 'expense' | 'arrival' | ...
  title, detail, amount_minor, currency,
  ref_type, ref_id,                                -- what it points at
  meta_json, created_at
)
```

Then:
* the chat feed, the dashboard's "Today's activity", and any future digest are
  **three views of one table**;
* an ntfy push becomes a *delivery of an event*, not a parallel implementation —
  so "two senders disagreeing" cannot recur;
* per-person notification preferences become "which `kind`s do I care about",
  over a stable taxonomy, instead of a per-module subscription grid;
* adding a fourth module to the activity feed is a new `kind`, not new plumbing.

Cost: a handful of rows a day. Volume is nothing — which is why this is cheap
now and gets more expensive to retrofit later.

**Design note on the chat.** The FleetDO should keep owning *realtime* (it is
the right tool: live socket, hibernation, ordering). The division I'd want:
`events` is the durable ledger, the DO is the transport. A module writes an
event → a small fan-out posts it into the DO for live delivery and to ntfy for
push. That is already the shape of `postSystemChat`; it just needs a ledger
behind it so the chat is no longer the only place the record lives.

---

## 3. Identity: five `users` tables, three id types, three password formats

Today a person exists in **four** places, with `home-db.users` (uuid TEXT),
`sompitra-db.users` (uuid), `way-db.users` (INTEGER + its own PBKDF2 that
doubles as the μlogger credential) and `laoka.users` (INTEGER + Laoka's HMAC
format). `src/identity.ts` is a compatibility layer that keeps them in step,
and it is the most delicate code in the app — the `is_admin` trap in
`CUTOVER.md` is a direct consequence of that duplication.

**Proposal:** `home-db` owns people; modules never store a credential again.

```sql
people(id, username, username_ci UNIQUE, display_name, role, ...)
person_modules(person_id, module, module_user_id, provisioned_at)
```

* The three module id formats become **data in a mapping table**, not branches
  in provisioning code.
* One password, one place — four copies of the same secret is a security smell
  in its own right.
* A new module is one row per person, not a fourth hash format.

How this duplication leaks into ordinary features, concretely: Kiné's payment
sync looked its income account up with `WHERE u.username='niri' AND
ia.name='Kiné Privée'`, in two handlers, and printed that person's name in the
form. A module that does not own identity has to name a person to reach their
data — so a rename, a second practitioner or an admin-created account broke the
feature silently. It now resolves the account (`kineIncomeAccount`: the signed-in
person's own `Kin%` account first, then any `Kiné Privée`) and prints the account
it actually found. That is the pattern, not the exception: **every hardcoded
username is a place where the missing mapping table is doing its work by hand.**

Caveat, and it's the important one: **Sompitra's `users` table stays.** The
mapping table means we reference it rather than migrate it — existing
`transactions.added_by_user_id` keeps pointing where it always did, and the
budget's attribution is never at risk. That is the whole reason the mapping
shape is worth the indirection.

---

## 4. Structured shopping items — the Laoka → Sompitra button

You gave this as the example of real seamlessness, and it is worth being blunt
about why it doesn't exist yet.

**An "itemized expense" in Sompitra today is a text blob.** The add-expense
modal's itemized mode runs client-side JS that builds a string —
`"Rice: Ar 5 000\nOil: Ar 12 000"` — and stores it in `transactions.notes`.
There is no item table. So per-item totals can't be summed, a single item can't
be corrected, an import can't be undone, and the Laoka hand-off is: export a CSV
from Laoka, download it, open Sompitra's expense modal, click "Import CSV",
pick the file. Four manual steps and a file lifecycle, for data both sides
already have.

**Proposal: make items real** (additive to Sompitra — nothing dropped):

```sql
transaction_items(
  id, transaction_id, name, qty, unit_price, amount,   -- money in MGA
  source,       -- 'manual' | 'laoka' | 'csv'
  source_ref,   -- the shopping_lines.id it came from
  sort_order
)
```

and on Laoka's side, one link:

```sql
week_shopping_lines(..., transaction_id)   -- set when sent to Sompitra
```

Then the button:

* **`POST /laoka/api/weeks/:id/send-to-sompitra`** reads the week's priced
  lines, creates **one** expense transaction (category chosen once, e.g.
  Groceries) plus N `transaction_items` rows, links them back, and stamps
  `weeks.exported_at`.
* **Idempotent by construction**: a week that is already linked cannot be sent
  twice, so a double-tap never double-charges the budget. Today's CSV path has
  no such guard — re-importing the same file creates a second expense.
* The existing CSV import becomes a second front-end to the same item writer,
  so the old workflow keeps working and gains structure.
* Backfill: the old notes blobs are parseable (`name: Ar 1 234` per line), so
  history can be migrated into `transaction_items` without guessing.
* Because items become rows, the expense shows *what was bought*, and the
  reports can finally answer "what does a week of food cost us" — which is the
  question the family app exists to answer.

---

## 5. Laoka's own schema, if it can be reset

Laoka carries `users` **and** `users_new`, plus `attempts`, `gourmet`, `plans`,
`plan_days`, `plan_day_items`, `items`, `subgroups`, `groups`, `weeks`,
`shopping_lines` and four `history_*` tables. Some of that is migration
sediment.

I'd keep the part that is genuinely well designed — the **snapshot** pattern
(`history_weeks`/`history_lines` capture a settled week immutably, and past
weeks export from the snapshot) — and normalise the rest to:

```
groups / subgroups / items        -- the catalog (as now)
weeks                             -- one row per week, status + budget
week_plan_items                   -- what is PLANNED to be cooked
week_shopping_lines               -- what is actually BOUGHT, with price
                                     + transaction_id  → Sompitra
week_snapshots / snapshot_lines   -- the archive, once settled
```

Two hard rules I'd encode in the schema rather than in code: a settled week is
**frozen** (no writes after snapshot), and a shopping line sent to Sompitra is
**linked** (so nothing can be sent twice). Both are currently conventions.

---

## 6. WAY's two traps, designed out

1. **`devices` is a ghost table.** No code reads it (`grep 'FROM devices' src/`
   → nothing), yet it is the FK parent of `messages.device_id`, which is what
   silently killed the entire chat flush (see `AGENTS.md` rule 19). Since the
   stated invariant is *one person == one device*, that column should reference
   the person directly, and the ghost table should go away.
2. **Two names for one thing.** The DO owns `chat_messages`; D1 owns `messages`,
   with a different shape (`sender` NOT NULL, nulls rewritten to `"System"`).
   Aligning the two makes the flush a straight copy instead of a translation —
   and translations are where data gets lost.

---

## 7. What I would *not* change

* **Keep four databases.** We are using 4 of 10 permitted, and the split buys
  real things: Sompitra's database can be left physically untouched (your one
  hard constraint), and a runaway in one module can't exhaust another's 500 MB.
  The unification belongs in *identity and the event ledger*, not in one giant
  physical DB. Merging would be the single most dangerous change available and
  would buy ~nothing.
* **Keep the Durable Objects.** SQLite-backed DOs are free-tier, hibernation
  keeps duration charges near zero, and a chat/telemetry fan-out is precisely
  what they are for.
* **Keep Sompitra's money tables exactly as they are.** Every proposal touching
  them is additive (`transaction_items`), because `transactions` is the one
  table whose loss is unacceptable.

---

## 8. If I were sequencing this

Ordered by *risk removed per unit of disruption*, not by visibility:

| # | Change | Why here |
| --- | --- | --- |
| 1 | **Index + GPS rollup + automated retention** | The only items that become an outage if ignored; invisible to users |
| 2 | **Laoka → Sompitra one-button send** | The visible "one app" moment; needs only `transaction_items` + a link column |
| 3 | **`events` ledger** | Kills the whole class of "two senders drifted" bugs; cheap now, costly later |
| 4 | **Identity mapping table** | Removes the most delicate code in the app, and `is_admin`-style traps with it |
| 5 | WAY/Laoka schema tidy-up | Real, but lowest urgency; only pays off at the next module |

Items 1 and 2 are independent and could proceed together. Item 4 touches login,
so it wants to happen when a re-login for both people is acceptable anyway —
i.e. alongside the `CUTOVER.md` deployment, not after it.
