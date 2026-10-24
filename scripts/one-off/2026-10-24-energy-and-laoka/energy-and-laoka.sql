-- ============================================================
-- One utility category ("Energy"), and every laoka/hena expense
-- filed under Laoka
-- ------------------------------------------------------------
-- 1. `cat_gas` ("Gaz") and `cat_water` ("Jirama") are the same line
--    on the household's utility bill, so they become one category
--    named Energy. `cat_water` survives — it holds the Jirama history
--    and the 80,000 monthly target — and Gaz's one transaction moves
--    onto it.
-- 2. Expenses whose description mentions laoka or hena are refiled
--    into the existing Laoka category (`cat_1f13a7b7`, an envelope),
--    whatever category they were under. Purchases only: funding
--    transfers stay with the envelope they fund, and income rows are
--    left alone because a category is not what an income row is for.
--
-- Idempotent: re-running changes nothing. Each step is guarded, so a
-- database without the survivor or without a Laoka category is left
-- untouched rather than having rows orphaned.
-- ============================================================

-- 1a. Gas spending becomes energy spending.
UPDATE transactions
   SET category_id = 'cat_water'
 WHERE category_id = 'cat_gas'
   AND EXISTS (SELECT 1 FROM categories WHERE id = 'cat_water');

-- 1b. One name for the survivor.
UPDATE categories
   SET name = 'Energy'
 WHERE id = 'cat_water';

-- 1c. Drop the duplicate only once nothing points at it.
DELETE FROM categories
 WHERE id = 'cat_gas'
   AND EXISTS (SELECT 1 FROM categories WHERE id = 'cat_water')
   AND NOT EXISTS (SELECT 1 FROM transactions WHERE category_id = 'cat_gas');

-- 2. Laoka and hena purchases join the Laoka envelope.
UPDATE transactions
   SET category_id = (SELECT id FROM categories WHERE lower(trim(name)) = 'laoka' ORDER BY id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND (lower(COALESCE(description, '')) LIKE '%laoka%'
     OR lower(COALESCE(description, '')) LIKE '%hena%')
   AND (category_id IS NULL
     OR category_id <> (SELECT id FROM categories WHERE lower(trim(name)) = 'laoka' ORDER BY id LIMIT 1))
   AND EXISTS (SELECT 1 FROM categories WHERE lower(trim(name)) = 'laoka');
