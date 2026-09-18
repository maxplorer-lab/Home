-- The shopping line gains an explicit bought flag, so a line can be ticked
-- without a price. The CSV still only exports lines that carry a price.
ALTER TABLE shopping_lines ADD COLUMN bought INTEGER NOT NULL DEFAULT 0;

-- Gourmet recipes carry their ingredients as text again. This is reference
-- material only: it never reaches the shopping list or the CSV.
ALTER TABLE gourmet ADD COLUMN ingredients TEXT;

-- Anything already priced was bought by definition.
UPDATE shopping_lines SET bought = 1 WHERE price IS NOT NULL AND price > 0;
