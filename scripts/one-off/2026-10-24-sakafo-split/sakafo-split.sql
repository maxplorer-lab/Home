-- ============================================================
-- ANDAVAN'ANDRO → Sakafo: split produce/protein/market rows into
-- Laoka, and dairy/breakfast rows into Goûter
-- ------------------------------------------------------------
-- Only purchases currently filed under the ANDAVAN'ANDRO group's
-- Sakafo category are touched. Matching is on the description, case
-- insensitive, and every target is resolved by name inside its own
-- group so a rename cannot send rows to the wrong place.
--
-- Laoka keywords: akoho, laoka, anana, kabaka, tongolo, trondro,
-- ovy, kotomila, atody, tsena, courgette, legume, sosisi, saucisse
-- Goûter keywords: mortadell/moratd (mortadelle and its misspellings),
-- ronono, fromage, mais doux
--
-- Envelope funding transfers are left where they are: only purchases
-- move, so neither envelope's balance is reinterpreted. Idempotent —
-- a second run finds nothing left to move.
-- ============================================================

-- 1. Produce, protein and market purchases join Laoka.
UPDATE transactions
   SET category_id = (SELECT id FROM categories WHERE lower(trim(name)) = 'laoka' ORDER BY id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo')
   AND (lower(description) LIKE '%akoho%'
     OR lower(description) LIKE '%laoka%'
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

-- 2. Dairy, cheese and breakfast items join Goûter.
UPDATE transactions
   SET category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Goûter' ORDER BY c.id LIMIT 1)
 WHERE type = 'expense'
   AND is_envelope_transfer = 0
   AND category_id = (
     SELECT c.id FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE g.name = 'ANDAVAN''ANDRO' AND c.name = 'Sakafo')
   AND (lower(description) LIKE '%mortadell%'
     OR lower(description) LIKE '%moratd%'
     OR lower(description) LIKE '%ronono%'
     OR lower(description) LIKE '%fromage%'
     OR lower(description) LIKE '%mais doux%');
