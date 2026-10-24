-- ============================================================
-- Pass 2 — same terms, every category in the ANDAVAN'ANDRO group
-- ------------------------------------------------------------
-- Pass 1 only looked inside Sakafo. These four passes look at every
-- category of the group (Laoka, Sakafo, Fitaovana an-trano, Goûter,
-- Samihafa, Dining Out, Fianankaviana, Voankazo) so the same item is
-- filed the same way wherever it was entered. Other groups are not
-- touched. Purchases only: envelope funding transfers stay put.
--
--   Laoka     akoho, laoka/loaka, anana, kabaka, tongolo, trondro,
--             ovy, kotomila, atody, tsena, courgette, legume, sosisi,
--             saucisse
--   Goûter    mortadell/moratd, ronono, fromage, mais doux
--   Dining Out vary, sakafo (which also covers "Sakafo maraina")
--   Samihafa  vinaigre, tofu, samihafa, voanjo, vianjo, siramamy
--
-- Rows already in their target are skipped, so re-running the file
-- reports no changes and touches no row.
-- ============================================================

-- 1. Laoka
UPDATE transactions
   SET category_id = (SELECT id FROM categories WHERE lower(trim(name)) = 'laoka' ORDER BY id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id IN (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO')
   AND category_id <> (SELECT id FROM categories WHERE lower(trim(name)) = 'laoka' ORDER BY id LIMIT 1)
   AND (lower(description) LIKE '%akoho%'
     OR lower(description) LIKE '%laoka%'
     OR lower(description) LIKE '%loaka%'
     OR lower(description) LIKE '%anana%'
     OR lower(description) LIKE '%kabaka%'
     OR lower(description) LIKE '%tongolo%'
     OR lower(description) LIKE '%trondro%'
     OR lower(description) LIKE '%ovy%'
     OR lower(description) LIKE '%kotomila%'
     OR lower(description) LIKE '%atody%'
     OR lower(description) LIKE '%tsena%'
     OR lower(description) LIKE '%courgette%'
     OR lower(description) LIKE '%legume%'
     OR lower(description) LIKE '%sosisi%'
     OR lower(description) LIKE '%saucisse%');

-- 2. Goûter
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Goûter' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id IN (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO')
   AND category_id <> (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Goûter' ORDER BY c.id LIMIT 1)
   AND (lower(description) LIKE '%mortadell%'
     OR lower(description) LIKE '%moratd%'
     OR lower(description) LIKE '%ronono%'
     OR lower(description) LIKE '%fromage%'
     OR lower(description) LIKE '%mais doux%');

-- 3. Dining Out
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Dining Out' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id IN (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO')
   AND category_id <> (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Dining Out' ORDER BY c.id LIMIT 1)
   AND (lower(description) LIKE '%vary%'
     OR lower(description) LIKE '%sakafo%');

-- 4. Samihafa
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Samihafa' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id IN (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO')
   AND category_id <> (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Samihafa' ORDER BY c.id LIMIT 1)
   AND (lower(description) LIKE '%vinaigre%'
     OR lower(description) LIKE '%tofu%'
     OR lower(description) LIKE '%samihafa%'
     OR lower(description) LIKE '%voanjo%'
     OR lower(description) LIKE '%vianjo%'
     OR lower(description) LIKE '%siramamy%');
