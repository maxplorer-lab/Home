-- ============================================================
-- Merge the Electricity category into Jirama
-- ------------------------------------------------------------
-- `cat_electricity` ("Electricity") and `cat_water` ("Jirama") both
-- describe the same bill, so the household keeps one category named
-- Jirama. Transaction history moves first, then the empty duplicate is
-- removed; nothing is deleted while a row still points at it.
--
-- Idempotent: re-running the file changes nothing.
-- The survivor is `cat_water` (already named Jirama in production;
-- local dev still carries the seed's "Water" name).
-- ============================================================

-- 1. Every Electricity transaction becomes a Jirama transaction.
--    Guarded so a database without the survivor is left untouched
--    rather than orphaning rows.
UPDATE transactions
   SET category_id = 'cat_water'
 WHERE category_id = 'cat_electricity'
   AND EXISTS (SELECT 1 FROM categories WHERE id = 'cat_water');

-- 2. One spelling for the survivor.
UPDATE categories SET name = 'Jirama' WHERE id = 'cat_water';

-- 3. Drop the duplicate only once nothing references it.
DELETE FROM categories
 WHERE id = 'cat_electricity'
   AND NOT EXISTS (SELECT 1 FROM transactions WHERE category_id = 'cat_electricity');
