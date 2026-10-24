# One-off: Gaz + Jirama → "Energy", and laoka/hena expenses → "Laoka"

Run 2026-10-24 against `DB` (sompitra-db) on production.

## Part 1 — one utility category

The Fixed Expenses group carried the same bill twice:

| id | name | transactions | target |
| --- | --- | --- | --- |
| `cat_gas` | Gaz | 1 (76,000, 2026-09-30) | 0 |
| `cat_water` | Jirama | 5 (incl. the 80,000 funding transfer) | 80,000 |

`cat_water` survives — it holds the jirama/rano history and the monthly
target — and is renamed **Energy**; the Gaz row moves onto it and the empty
`cat_gas` row is deleted.

## Part 2 — a single Laoka category

The existing Laoka category is `cat_1f13a7b7` (group ANDAVAN'ANDRO, an
envelope with a 300,000 target). Sixteen expense rows whose description
mentions *laoka* or *hena* were filed elsewhere and now move onto it:

- 15 rows from Sakafo (`cat_groceries`) — "Laoka", "laoka",
  "Laoka SEP 12 SEP 18" — 185,400
- 1 row from Mahalana (`cat_16de4772`) — "Raharaha hena" — 77,500

Total refiled: 262,900.

Deliberately not moved:

- "Valopy laoka" (60,000) and "Hena Omby" (3,000) — already in Laoka.
- "Comple 4 all - Hena vinaks" — an **income** row (40,000) with no
  category; an expense category is not where income belongs.
- Envelope funding transfers (`is_envelope_transfer = 1`) stay with the
  envelope they fund, so no envelope's balance is reinterpreted.

## How to run

```bash
cd D:\Freebuff\Home
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-24-energy-and-laoka/energy-and-laoka.sql
```

Not run against local dev: that database is the seed fixture (English
category names, no Laoka category), and it is what `scripts/smoke.mjs`
drives — including its `cat_gas` quick-add probe, which the merge removes.

Every statement is guarded by data, so re-running the file is a no-op.

## Verify

```sql
SELECT id, name, target_budget FROM categories WHERE id IN ('cat_gas','cat_water');
SELECT category_id, COUNT(*), SUM(amount) FROM transactions
 WHERE category_id IN ('cat_gas','cat_water') GROUP BY category_id;
SELECT COUNT(*), SUM(amount) FROM transactions WHERE category_id = 'cat_1f13a7b7';
SELECT date, description, category_id FROM transactions
 WHERE type = 'expense'
   AND (lower(COALESCE(description,'')) LIKE '%laoka%' OR lower(COALESCE(description,'')) LIKE '%hena%')
   AND category_id <> 'cat_1f13a7b7';
```

Expected after the fix: only `cat_water | Energy | 80000` exists, holding all
six transactions (`cat_gas` returns no row); Laoka holds 20 rows; the last
query returns no category other than `cat_1f13a7b7`.
