# One-off: Electricity + Jirama → one category, "Jirama"

Run 2026-10-23 against `DB` (sompitra-db) on production and local dev.

The Fixed Expenses group carried two categories for the same utility bill:

| id | name in production | transactions |
| --- | --- | --- |
| `cat_electricity` | Electricity | 2 (90,300 total) |
| `cat_water` | Jirama | 2 (25,600 total) |

`cat_water` already carried the name the household uses, so it survives; the
Electricity rows move onto it and the duplicate row is deleted. Nothing else
references either category (no envelope, no debt account, no recurring link
beyond the transactions themselves).

## How to run

```bash
cd D:\Freebuff\Home
npx wrangler d1 execute DB --local  --file=scripts/one-off/2026-10-23-merge-jirama/jirama.sql
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-23-merge-jirama/jirama.sql
```

Every statement is guarded by data, so re-running the file is a no-op.

## Verify

```sql
SELECT id, name FROM categories WHERE id IN ('cat_electricity','cat_water');
SELECT category_id, COUNT(*) FROM transactions
 WHERE category_id IN ('cat_electricity','cat_water') GROUP BY category_id;
```

Expected after the fix: only `cat_water | Jirama` exists, holding all four
transactions (`cat_electricity` returns no row).
