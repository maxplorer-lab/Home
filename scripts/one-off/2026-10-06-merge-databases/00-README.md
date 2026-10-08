# Four databases became two (2026-10-06)

`home-db` + `way-db` are now ONE database, and `sompitra-db` + `laoka` are the
other one. Nothing was deleted: the two superseded databases are kept as the
rollback.

## What changed, exactly

| Binding | Before | After |
| --- | --- | --- |
| `HOME_DB` | `home-db` (`fd140c5d…`) | `home-db` (`fd140c5d…`) — unchanged |
| `WAY_DB` | `way-db` (`e098df3d…`) | **`home-db`** (`fd140c5d…`) |
| `DB` | `sompitra-db` (`701cd942…`) | `sompitra-db` (`701cd942…`) — unchanged |
| `LAOKA_DB` | `laoka` (`24acf3ed…`) | **`sompitra-db`** (`701cd942…`) |

The bindings keep their names on purpose (rule 12): each module's code asks for
its own, and the pair resolving to one physical database is a `wrangler.jsonc`
fact, not a code fact. Three tables had to be renamed, because `users` and
`sessions` were already taken in the host database:

* `way-db.users` → `way_users`
* `laoka.users` → `laoka_users`
* `laoka.sessions` → `laoka_sessions`

Everything else kept its name — the two halves of each pair had no other
collision (checked table-by-table and index-by-index; every foreign key stays
inside its own module).

## Why merge at all (the free tier, as it actually stands)

D1's free plan is **5 GB total storage, 500 MB per database, 10 databases per
account, 5 M rows read/day and 100 k rows written/day**. Before the merge the
account held six databases totalling ~7 MB, so nothing was close to a limit and
this was never a capacity fix — the win is one fewer place for a fact to live,
one fewer place to apply a migration, and two free database slots.

A merged database is **not** cheaper or dearer to run: rows read and written are
the same rows, just in one file, and the merged pair stay far under 500 MB.

## Running the merge

```bash
# 1. Dry run — exports and rewrites, writes NO database
node scripts/one-off/2026-10-06-merge-databases/merge-databases.mjs all

# 2. The real thing (schema, then data, then a row-count check of both sides)
node scripts/one-off/2026-10-06-merge-databases/merge-databases.mjs all --apply

# 3. Prove every binding still matches its migrations
npm run audit:remote        # four bindings, all green
```

Order matters, and it is the reason no window is lost:

1. **Merge first, deploy second.** Until the Worker is redeployed, every binding
   still points at the OLD databases, so the running app is untouched by the
   copy. The copy reads `way-db` and `laoka` **by name** (`wrangler d1 export`
   resolves a bare database name), which is what makes it possible to read a
   database no binding mentions any more.
2. **Deploy** (`npm run deploy`). The new tree is the only one that knows about
   `way_users` / `laoka_users` / `laoka_sessions`.
3. **Verify** with `npm run audit:remote` and `/admin/diagnostics.json` (the
   probes are labelled `way (in home-db)` and `laoka (in sompitra-db)`).

Avoid 21:00 UTC — that is W.A.Y's cron flush into `way-db`, and a flush that
lands between the copy and the deploy is the one write the copy cannot see.

## Rolling back

Nothing in this directory deletes anything. To go back, remove the two added
`d1_databases` entries in `wrangler.jsonc` (the `WAY_DB` → `home-db` and
`LAOKA_DB` → `sompitra-db` lines) and redeploy: `way-db` and `laoka` still hold
every row they held at the time of the merge, because the copy is a copy.

## Proving the archive stands alone

`out/` is gitignored and lives on one machine, so "the copy is a copy" is a
claim about two live databases, never about the files. `verify-archive.mjs`
checks the files, and it is what a decision to DELETE the rollback pair has to
stand on:

```bash
node scripts/one-off/2026-10-06-merge-databases/verify-archive.mjs
```

It replays `out/*.sql` the way D1 runs a `--file` — statement by statement with
foreign keys ON, so a child row ahead of its parent still fails — then compares
every table **row for row** (a SHA-256 over every column of every row, not a
row count) against both the merged database and the superseded original. The
live side is read with one `wrangler d1 export` per database, cached in
`scratch/exports/`; add `--fresh` to take a new snapshot. One call per database
rather than one per table, because paging a remote table costs a whole wrangler
start-up per page and `gps_pings` alone is 43 k rows.

The two comparisons are held to different standards, deliberately. The merged
database keeps taking writes (the 21:00 UTC cron flushes pings into it), so a
table that has merely GROWN is reported as **drift** and not counted as a
failure — and once it has grown it cannot be hashed against a snapshot of
itself at all. The superseded pair is frozen, so it is compared strictly with no
drift allowance: that half is the claim a delete rests on.

Result on 2026-10-06: **core 8 tables and household 19 tables identical on both
sides, and every table in `way-db` and `laoka` is covered by the archive** — so
the pair holds nothing the files do not already hold. (`home-db` and
`sompitra-db` each have tables this archive never had — Sompitra's money tables,
Home's `people`/`ledger` — which are outside the merge and are listed, not
compared.)

Falsified before it was believed: `scratch/falsify.mjs` shows the replay refuses
`messages` before `devices`, and that a single changed value or one deleted row
moves the digest.

That is the evidence the pair *can* be retired on. It is not the same as having
retired it: `out/` is still local-only, so deleting is only as safe as this
directory's backup.

## What the copy deliberately does NOT do

It does not run `migrations-way/*` or `migrations-laoka/*` against the host. That
would have inserted the files' own seed rows (nine geofences, two devices, the
Laoka catalogue) into a database that is about to receive production's rows, and
the live rows then collide with the seeds on a UNIQUE name. Instead the script
takes the **live database's own schema** (`d1 export --no-data`) and applies
production's exact `CREATE TABLE` statements, renamed. The migration files still
have to agree with the result — which is what step 3 checks.

## Two things the dump cannot be trusted to get right

D1 runs a `--file` statement by statement and does **not** defer foreign keys,
so the `PRAGMA defer_foreign_keys=TRUE` the export writes (and SQLite honours)
buys nothing there. Two consequences, both now handled by the script:

* **Row order.** `way-db`'s dump emits `messages` (FK → `devices.device_id`)
  five blocks before `devices`, and the first apply died with
  `FOREIGN KEY constraint failed`. The data file is re-sorted so every table
  comes after the tables it references — Kahn's algorithm, scanning the file's
  own order each pass so unrelated tables do not move.
* **Statement size.** D1 refuses a single statement much past 100 KB
  (`SQLITE_TOOBIG`). Laoka keeps a recipe photo inline as a base64 data URL, and
  one `gourmet` row is 177 KB on its own. Such a row becomes a short INSERT with
  the big column emptied, then a run of `UPDATE … SET col = col || '<piece>'`
  statements under 16 KB each. The image comes out byte-identical (checked by
  length and head/tail against the source).

The row-count check had the same shape of bug: it counted the **source** by the
*rewritten* table names, and `way_users` does not exist in `way-db`. Each
renamed table is now counted by the name it actually has on the source side.

## Two traps worth remembering

* **`\busers\b` is load-bearing.** W.A.Y's `messages` carries a column called
  `reaction_users`, and `_` is a word character, so the rewrite cannot reach
  inside it. The index renames (`idx_users_username` → `idx_laoka_users_username`
  and the two session indexes) are listed separately because an index NAME has no
  word boundary before `users` either.
* **Local state is keyed to the binding's `database_id`** (AGENTS.md rule 17),
  so editing `WAY_DB`/`LAOKA_DB` in `wrangler.jsonc` orphans that module's local
  fixtures in the old `.wrangler/state/v3/d1/*.sqlite` file. The symptoms are
  odd rather than obvious: the module still answers, but its data is empty
  (smoke trips on `a live Laoka week exists to hand over`, because the merged
  database has no `weeks` row yet). The old file is still on disk; copy the rows
  back instead of re-bootstrapping.
