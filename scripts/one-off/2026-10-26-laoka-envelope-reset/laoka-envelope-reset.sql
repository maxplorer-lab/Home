-- ============================================================
-- Reset the Laoka envelope to zero
-- ------------------------------------------------------------
-- The household wants Laoka to read 0 funded / 0 spent with its
-- existing 300,000 target, from 2026-10-26.
--
-- The envelope is only ever described by its transactions (see
-- src/lib/envelope.ts), so "reset" means two data facts:
--
--   1. the single funding transfer that filled it is removed, which
--      returns that money to the main pot and makes `funded` 0;
--   2. the envelope OPENS TODAY. `envelope_from` is the app's own
--      boundary: spending dated before it is ordinary category
--      spending, not envelope spending. Moving it to today is what
--      the expense form does on a category's first funding, so the
--      22–25 Oct purchases stop counting against the envelope and
--      `carried` / `spent` both read 0.
--
-- Purchases are NOT touched. The 34,600 of real groceries stays in
-- Laoka and in every report; only which pot paid for them changes.
--
-- Idempotent: every statement is guarded by the row it expects, so
-- re-running changes nothing.
-- ============================================================

-- 1. Unfund the envelope: its only funding row, "Valopy Laoka".
DELETE FROM transactions
 WHERE id = 'bc03cb97-3a6d-41bc-b4d9-5dd45202d985'
   AND category_id = 'cat_1f13a7b7'
   AND type = 'expense'
   AND is_envelope_transfer = 1
   AND amount = 34000;

-- 2. The envelope opens on the day of the reset. Never move an
--    envelope that already opened later than this.
UPDATE categories
   SET envelope_from = '2026-10-26'
 WHERE id = 'cat_1f13a7b7'
   AND (envelope_from IS NULL OR envelope_from < '2026-10-26');

-- 3. Assert the target the household asked for. Already 300,000 in
--    production, so this is a no-op there; it is here so the script
--    states the whole intent.
UPDATE categories
   SET target_budget = 300000
 WHERE id = 'cat_1f13a7b7'
   AND target_budget <> 300000;
