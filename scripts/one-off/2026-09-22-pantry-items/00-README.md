# Pantry items, edited on their own — and the shape of the shelves on Home

One-off for the batch that made a pantry **item** editable (name, category, count,
reorder level) instead of counts-only, and put a compact pantry card at the foot of
Home's dashboard.

## What shipped

| Where | What |
| --- | --- |
| `public/laoka/app.js` | each pantry row carries its own ✏️ and 🗑; the sheet holds **name · category · count · level**; a link (`?tab=`) opens the tab it names |
| `src/laoka/routes/pantry.js` | `PATCH /api/pantry/items/:id` takes any subset, refuses a blank name, refuses a destination that is not a pantry category |
| `src/laoka/data/queries.js` | `updatePantryItem` (was `setItemStock`) writes ONLY the fields sent; `pantrySummary` for the card |
| `src/routes/dashboard.tsx` | the last card: items · categories · to buy, and one tap into the pantry |
| `src/views/shell.tsx` | a plain lowercase `?tab` travels into the frame's src; anything else is dropped |
| `src/index.tsx` | `/laoka/` hands the query through to the shell |

## What this driver is for

A guard that cannot go red is decoration. These guards live in **two** sections of
`scripts/smoke.mjs` — §17 (the shell carrying an inner tab) and §22 (the item
editor, and the card's numbers) — so this extracts both, preflights them unmutated,
then mutates ONE path at a time and requires that path's own check to go red.

```bash
# from Home/, with `npm run dev` up on 8793 and a local database
node scripts/one-off/2026-09-22-pantry-items/mutate.mjs        # all 11, ~8 min
node scripts/one-off/2026-09-22-pantry-items/mutate.mjs M7 M9  # a subset
```

The preflight fails the run — without touching any file — if an expected check is
already red or never executes, and a mutation whose anchor no longer matches the
file is reported `SKIPPED` and also fails the run: a mutation that changes no code
proves nothing.

Two things this driver learned the hard way, and now does for every mutation:

* **Restore in flight on an abnormal exit.** A run piped through `head` died on a
  closed pipe mid-M9 and left `public/laoka/app.js` carrying the M5 fault. The next
  run's preflight then went red on a clean-looking tree, and the leftover looked
  like a bug in the guard. `SIGINT` / `SIGHUP` / `SIGTERM` / `uncaughtException`
  now rewrite every file in flight.
* **Wait for the dev server after writing a file.** Writing triggers a reload, and a
  fetch landing mid-reload came back with `/laoka/index.html` missing its embed
  block — four unrelated §17 checks went red and the section threw `fetch failed`,
  which reads exactly like a caught mutation that proves nothing.

## Probes it creates

One soft-deleted shelf (`zz smoke pantry shelf <stamp>`) and one soft-deleted item
(`zz smoke edit probe <stamp>`) per run, in the **local** Laoka database only — the
suite never runs against a deployed database. The names carry a timestamp because a
name is unique *while it lives*: a crashed run that skipped its cleanup would
otherwise make the next run fail with "that name already exists", i.e. a suite that
depends on what a previous crash left behind. Cleanup uses the catalogue's
`DELETE /api/items/:id`, which deletes an item in either domain — the pantry's own
door refuses an item a mutation moved into the meal catalogue, and that refusal is
the point of one of the checks.
