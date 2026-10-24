-- ============================================================
-- Pass 3 — empty the ANDAVAN'ANDRO Sakafo category and remove it
-- ------------------------------------------------------------
-- The four grocery leftovers (Sardine, Rano, Citron, Gasy) go to
-- Samihafa; Yaourt goes to Goûter, where the other dairy rows live.
-- Once the last row has left, the Sakafo category itself is deleted.
--
-- Purchases only, and the delete is guarded: it happens only when no
-- transaction and no debt/credit account still points at the category,
-- so a re-run, or a database where a target is missing, cannot orphan
-- a row.
-- ============================================================

-- 1. Groceries (everything except yogurt) join Samihafa.
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Samihafa' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo')
   AND lower(description) NOT LIKE '%yaourt%';

-- 2. Yogurt joins Goûter.
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Goûter' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo')
   AND lower(description) LIKE '%yaourt%';

-- 3. Drop Sakafo once nothing references it.
DELETE FROM categories
 WHERE id = (
   SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
    WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo')
   AND NOT EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.category_id = (
        SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
         WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo'))
   AND NOT EXISTS (
     SELECT 1 FROM debt_credit_accounts d
      WHERE d.category_id = (
        SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
         WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo'));
