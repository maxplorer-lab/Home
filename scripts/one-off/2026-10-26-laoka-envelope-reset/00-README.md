# One-off: reset the Laoka envelope to zero

Run 2026-10-26 against `DB` (sompitra-db) on production.

## Applied

Run on production on 2026-10-26: 3 statements, 2 rows written (the funding
row and `envelope_from`). Verified with the query below — Laoka reads target
300000, `envelope_from` 2026-10-26, funded 0, spent 0, carried 0; Energy is
untouched at 150000 / 100000 / 0 / 0. Laoka still holds 55 rows, and this
cycle's real Laoka spending is still 28,600.

## What it was (before the reset)

Live state before the reset, in the running cycle (24 Oct → 23 Nov) and
computed exactly as `envelopeBalances()` does:

| | |
| --- | --- |
| category | `cat_1f13a7b7` — Laoka (ANDAVAN'ANDRO) |
| target | 300,000 |
| `envelope_from` | 2026-10-22 |
| carried | **−6,000** — Tsena 3,000 (22 Oct), Hena Omby 3,000 (23 Oct) |
| funded | **34,000** — one row: "Valopy Laoka", 26 Oct 09:57 |
| spent | **28,600** — five rows, 24–25 Oct |
| left | **−600** |

Energy (`cat_water`) was already correct — 150,000 target, 100,000 funded,
0 spent — and this script does not touch it.

## What it does

1. **Unfunds the envelope.** Deletes its only funding row, "Valopy Laoka"
   (`bc03cb97-3a6d-41bc-b4d9-5dd45202d985`, 34,000, 2026-10-26), so `funded`
   is 0 and the money is back in the main pot. Nothing references that row:
   debt accounts, debt payments, client payments, sales records and pantry
   trips all return 0.
2. **Opens the envelope today** by moving `envelope_from` to 2026-10-26.
   Spending dated before it is ordinary category spending, not envelope
   spending — which is exactly the mechanism the expense form uses when a
   category is funded for the first time. So `carried` and `spent` both read 0.
3. **Asserts the 300,000 target** (already correct in production; the
   statement is a no-op there).

After: carried 0, funded 0, spent 0, left 0, target 300,000.

## What it deliberately does not do

- **The purchases stay.** The 34,600 of real groceries on 22–25 Oct remain in
  Laoka and in every report. Only the envelope ledger is reset, so Budget's
  progress bar still prints this cycle's Ar 28,600 — that money was really
  spent.
- **Cash on hand falls by 600.** The 34,000 funding returns to the main pot,
  while the 34,600 of purchases become main-pot spending instead of envelope
  spending. The −600 is exactly the overdraft the envelope was carrying, so
  net worth is unchanged.
- No schema change, no code change.

## How to run

```bash
cd D:\Freebuff\Home
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-26-laoka-envelope-reset/laoka-envelope-reset.sql
```

Idempotent: every statement is guarded by the row it expects, so re-running
changes nothing.

## Verify

The same sums `envelopeBalances()` binds, for Laoka and Energy:

```sql
SELECT c.id, c.name, c.target_budget, c.envelope_from,
       COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 1 AND t.date BETWEEN '2026-10-24' AND '2026-11-23' THEN t.amount END), 0) AS funded,
       COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 0 AND t.date BETWEEN '2026-10-24' AND '2026-11-23' AND t.date >= c.envelope_from THEN t.amount END), 0) AS spent,
       COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 1 AND t.date < '2026-10-24' THEN t.amount END), 0)
         - COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 0 AND t.date < '2026-10-24' AND t.date >= c.envelope_from THEN t.amount END), 0) AS carried_in
  FROM categories c
  LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'expense'
 WHERE c.id IN ('cat_1f13a7b7', 'cat_water')
 GROUP BY c.id;
```

Expected:

| id | name | target | envelope_from | funded | spent | carried |
| --- | --- | --- | --- | --- | --- | --- |
| `cat_1f13a7b7` | Laoka | 300000 | 2026-10-26 | 0 | 0 | 0 |
| `cat_water` | Energy | 150000 | 2026-10-23 | 100000 | 0 | 0 |

## Rollback

The deleted row, in full (so it can be restored exactly):

```text
id                  bc03cb97-3a6d-41bc-b4d9-5dd45202d985
date                2026-10-26
amount              34000
type                expense
income_account_id   NULL
category_id         cat_1f13a7b7
description         Valopy Laoka
notes               NULL
added_by_user_id    usr_niri
is_recurring        0
created_at          2026-10-26 09:57:24
is_envelope_transfer 1
```

```sql
INSERT INTO transactions
  (id, date, amount, type, income_account_id, category_id, description, notes,
   added_by_user_id, is_recurring, created_at, is_envelope_transfer)
VALUES
  ('bc03cb97-3a6d-41bc-b4d9-5dd45202d985', '2026-10-26', 34000, 'expense', NULL,
   'cat_1f13a7b7', 'Valopy Laoka', NULL, 'usr_niri', 0,
   '2026-10-26 09:57:24', 1);

UPDATE categories SET envelope_from = '2026-10-22' WHERE id = 'cat_1f13a7b7';
```
